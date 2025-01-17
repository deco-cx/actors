// deno-lint-ignore-file no-explicit-any
import { isEventStreamResponse } from "./stream.ts";
import type { ActorInvoker } from "./stubutil.ts";
import {
  type ChannelUpgrader,
  type DuplexChannel,
  ignoreIfClosed,
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
  invoke: Parameters<ActorInvoker["invoke"]>;
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
export const rpc = (invoker: ActorInvoker): ChannelUpgrader<
  InvokeResponse,
  InvokeRequest
> => {
  return async ({ send, recv, signal }) => {
    const promises: Promise<void>[] = [];
    const streams: Map<string, AsyncIterableIterator<any>> = new Map();
    const channels: Map<string, DuplexChannel<any, any>> = new Map();

    try {
      for await (const invocation of recv()) {
        if (signal.aborted) break;

        if ("channel" in invocation && "message" in invocation) {
          const channel = channels.get(invocation.id);
          if (!channel || channel.signal.aborted) {
            channels.delete(invocation.id);
            await send({ id: invocation.id, channel: true, close: true })
              .catch(ignoreIfClosed);
            continue;
          }
          await channel.send(invocation.message)
            .catch(async (err) => {
              console.error("error sending message through channel", err);
              channel.close();
              channels.delete(invocation.id);
              await send({ id: invocation.id, channel: true, close: true })
                .catch(ignoreIfClosed);
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
            await stream.return?.();
            streams.delete(invocation.id);
          }
          continue;
        }

        const promise = (async () => {
          try {
            const result = await invoker.invoke(...invocation.invoke);

            if (signal.aborted) return;

            if (isEventStreamResponse(result)) {
              streams.set(invocation.id, result);
              let error: undefined | unknown;

              try {
                await send({
                  id: invocation.id,
                  stream: true,
                  start: true,
                }).catch(ignoreIfClosed);

                for await (const chunk of result) {
                  if (signal.aborted) break;
                  await send({
                    id: invocation.id,
                    result: chunk,
                    stream: true,
                  }).catch(ignoreIfClosed);
                }
              } catch (err) {
                error = err;
              } finally {
                streams.delete(invocation.id);
                if (!signal.aborted) {
                  await send({
                    id: invocation.id,
                    stream: true,
                    end: true,
                    error: error ? convertError(error) : undefined,
                  }).catch(ignoreIfClosed);
                }
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
                }).catch(ignoreIfClosed);

                for await (const message of result.recv(signal)) {
                  await send({
                    id: invocation.id,
                    channel: true,
                    message,
                  }).catch((err) => {
                    if (!signal.aborted) throw err;
                  });
                }
              } finally {
                channels.delete(invocation.id);
                if (!signal.aborted) {
                  await send({
                    id: invocation.id,
                    channel: true,
                    close: true,
                  }).catch(ignoreIfClosed);
                }
              }
              return;
            }

            await send({
              id: invocation.id,
              result,
            }).catch(ignoreIfClosed);
          } catch (error) {
            if (signal.aborted) return;
            const payload = convertError(error);
            await send({
              ...payload,
              id: invocation.id,
            }).catch(ignoreIfClosed);
          }
        })();

        promises.push(promise);
      }
    } finally {
      // Clean up
      for (const stream of streams.values()) {
        await stream.return?.().catch(console.error);
      }
      streams.clear();

      for (const channel of channels.values()) {
        channel.close();
      }
      channels.clear();

      await Promise.allSettled(promises);
    }
  };
};
