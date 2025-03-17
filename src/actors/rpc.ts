// deno-lint-ignore-file no-explicit-any
import { isEventStreamResponse } from "./stream.ts";
import type { StubInvoker } from "./stub/stubutil.ts";
import {
  type ChannelUpgrader,
  type DuplexChannel,
  isChannel,
} from "./util/channels/channel.ts";

export interface InvokeResponseBase {
  id: string;
}

export interface InvokeCancelStreamRequest {
  id: string;
  cancelStream: true;
}

export interface InvokeCloseChannelRequest {
  id: string;
  channel: true;
  close: true;
}

export interface InvokeActorRequest {
  id: string;
  invoke: Parameters<StubInvoker["invoke"]>;
}

export interface InvokeChannelMessage {
  id: string;
  channel: true;
  message: any;
}

export type InvokeRequest =
  | InvokeActorRequest
  | InvokeCancelStreamRequest
  | InvokeCloseChannelRequest
  | InvokeChannelMessage;

export interface InvokeResultResponse extends InvokeResponseBase {
  result: any;
}

export interface InvokeResultChannelOpened extends InvokeResponseBase {
  channel: true;
  opened: true;
}

export interface InvokeResultChannelClosed extends InvokeResponseBase {
  channel: true;
  close: true;
}

export interface InvokeResultChannelMessage extends InvokeResponseBase {
  channel: true;
  message: any;
}

export interface InvokeResultResponseStream extends InvokeResponseBase {
  result: any;
  stream: true;
}

export interface InvokeResultResponseStreamStart extends InvokeResponseBase {
  stream: true;
  start: true;
}
export interface InvokeResultResponseStreamEnd extends InvokeResponseBase {
  stream: true;
  end: true;
  error?: unknown;
}

export interface InvokeErrorResponse extends InvokeResponseBase {
  error: unknown;
  constructorName?: string;
}

export type InvokeResponse =
  | InvokeResultChannelOpened
  | InvokeResultChannelClosed
  | InvokeResultChannelMessage
  | InvokeResultResponse
  | InvokeErrorResponse
  | InvokeResultResponseStreamStart
  | InvokeResultResponseStream
  | InvokeResultResponseStreamEnd;

const convertError = (error: unknown) => {
  const constructorName = error?.constructor?.name;
  if (constructorName) {
    const serializedError = JSON.stringify(
      error,
      Object.getOwnPropertyNames(error),
    );
    return {
      constructorName,
      error: serializedError,
    };
  }
  return {
    error,
  };
};
export const rpc = (invoker: StubInvoker, metadata?: unknown): ChannelUpgrader<
  InvokeResponse,
  InvokeRequest
> => {
  return async ({ send, recv, signal }) => {
    const promises: Promise<void>[] = [];
    const streams: Map<string, AsyncIterableIterator<any>> = new Map();
    const channels: Map<string, DuplexChannel<any, any>> = new Map();

    for await (const invocation of recv()) {
      if ("channel" in invocation && "message" in invocation) {
        const channel = channels.get(invocation.id);
        if (!channel) {
          await send({ id: invocation.id, channel: true, close: true });
          continue;
        }
        if (channel.signal.aborted) {
          channels.delete(invocation.id);
          await send({ id: invocation.id, channel: true, close: true });
          continue;
        }
        await channel.send(invocation.message).catch((err) => {
          console.error("error sending message through channel", err);
        });
        continue;
      }
      if ("channel" in invocation && "close" in invocation) {
        const channel = channels.get(invocation.id);
        if (channel) {
          channel.close();
          channels.delete(invocation.id);
        }
        continue;
      }
      if ("cancelStream" in invocation) {
        const stream = streams.get(invocation.id);
        if (stream) {
          stream.return?.();
          streams.delete(invocation.id);
        }
        continue;
      }
      const [actorName, methodName, args, meta, connect] = invocation.invoke;
      promises.push(
        invoker.invoke(
          actorName,
          methodName,
          args,
          typeof metadata === "object" && typeof meta === "object"
            ? { signal, ...metadata, ...meta }
            : meta ?? metadata,
          connect,
        )
          .then(async (result) => {
            if (isEventStreamResponse(result)) {
              let error: undefined | unknown;
              try {
                streams.set(invocation.id, result);
                await send({
                  id: invocation.id,
                  stream: true,
                  start: true,
                });
                for await (const chunk of result) {
                  await send({
                    id: invocation.id,
                    result: chunk,
                    stream: true,
                  });
                }
              } catch (err) {
                error = err;
              } finally {
                await send({
                  id: invocation.id,
                  stream: true,
                  end: true,
                  error: error ? convertError(error) : undefined,
                });
                streams.delete(invocation.id);
              }
              return;
            }
            if (isChannel(result)) {
              channels.set(invocation.id, result);
              try {
                await send({
                  id: invocation.id,
                  channel: true,
                  opened: true,
                });
                for await (const message of result.recv()) {
                  await send({
                    id: invocation.id,
                    channel: true,
                    message,
                  });
                }
              } catch (err) {
                if (result.signal.aborted) {
                  return;
                }
                console.error(`could not send channel message: ${err}`);
              } finally {
                channels.delete(invocation.id);
                await send({ id: invocation.id, channel: true, close: true })
                  .catch((err) => {
                    console.error(
                      `could not send close channel message: ${err}`,
                    );
                  });
              }
              return;
            }
            return send({
              id: invocation.id,
              result,
            });
          })
          .catch((error) => {
            const payload = convertError(error);
            return send({
              ...payload,
              id: invocation.id,
            });
          }),
      );
    }
    streams.forEach((stream) => stream.return?.());
    channels.forEach((channel) => channel.close());
    await Promise.allSettled(promises);
  };
};
