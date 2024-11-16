// deno-lint-ignore-file no-explicit-any
import type { ActorInvoker } from "./proxyutil.ts";
import { isEventStreamResponse } from "./stream.ts";
import type { ChannelUpgrader } from "./util/channels/channel.ts";

export interface InvokeResponseBase {
  id: string;
}

export interface InvokeCancelStreamRequest {
  id: string;
  cancelStream: true;
}

export interface InvokeActorRequest {
  id: string;
  invoke: Parameters<ActorInvoker["invoke"]>;
}
export type InvokeRequest = InvokeActorRequest | InvokeCancelStreamRequest;
export interface InvokeResultResponse extends InvokeResponseBase {
  result: any;
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
}

export interface InvokeErrorResponse extends InvokeResponseBase {
  error: unknown;
  constructorName?: string;
}

export type InvokeResponse =
  | InvokeResultResponse
  | InvokeErrorResponse
  | InvokeResultResponseStreamStart
  | InvokeResultResponseStream
  | InvokeResultResponseStreamEnd;
export const rpc = (invoker: ActorInvoker): ChannelUpgrader<
  InvokeResponse,
  InvokeRequest
> => {
  return async ({ send, recv }) => {
    const promises: Promise<void>[] = [];
    const streams: Map<string, AsyncIterableIterator<any>> = new Map();
    for await (const invocation of recv()) {
      if ("cancelStream" in invocation) {
        const stream = streams.get(invocation.id);
        if (stream) {
          stream.return?.();
          streams.delete(invocation.id);
        }
        continue;
      }
      promises.push(
        invoker.invoke(...invocation.invoke)
          .then(async (result) => {
            if (isEventStreamResponse(result)) {
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
              } finally {
                await send({
                  id: invocation.id,
                  stream: true,
                  end: true,
                });
                streams.delete(invocation.id);
              }
              return;
            }
            return send({
              id: invocation.id,
              result,
            });
          })
          .catch((error) => {
            const constructorName = error?.constructor?.name;
            if (constructorName) {
              const serializedError = JSON.stringify(
                error,
                Object.getOwnPropertyNames(error),
              );
              return send({
                constructorName,
                error: serializedError,
                id: invocation.id,
              });
            }
            return send({
              error,
              id: invocation.id,
            });
          }),
      );
    }
    streams.forEach((stream) => stream.return?.());
    await Promise.allSettled(promises);
  };
};
