// deno-lint-ignore-file no-explicit-any
import process from "node:process";
import type { InvokeRequest, InvokeResponse } from "../rpc.ts";
import type { Actor, ActorConstructor } from "../runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "../stream.ts";
import type { ActorStub, StubServer, StubServerOptions } from "./stub.ts";
import {
  type Channel,
  type ChannelUpgrader,
  ClosedChannelError,
  type DuplexChannel,
  makeChan,
  makeDuplexChannelWith,
  makeWebSocket,
} from "../util/channels/channel.ts";
import { readAsBytes } from "../util/channels/chunked.ts";
import { retry } from "../util/retry.ts";

export const STUB_MAX_CHUNK_SIZE_QS_NAME = "max_chunk_size";
export const STUB_CONSTRUCTOR_NAME_HEADER = "x-error-constructor-name";

export type StubFactory<TInstance, TArgs extends unknown[] = [string]> = {
  new: StubFactoryFn<TInstance, TArgs>;
};

export type StubFactoryFn<TInstance, TArgs extends unknown[] = [string]> = (
  ...args: TArgs
) => ActorStub<TInstance>;
/**
 * Promise.prototype.then onfufilled callback type.
 */
export type Fulfilled<R, T> = ((result: R) => T | PromiseLike<T>) | null;

/**
 * Promise.then onrejected callback type.
 */
export type Rejected<E> = ((reason: any) => E | PromiseLike<E>) | null;

export interface StubInvoker<
  TResponse = any,
  TChannel extends DuplexChannel<unknown, unknown> = DuplexChannel<
    unknown,
    unknown
  >,
> {
  invoke(
    name: string,
    method: string,
    methodArgs: unknown[],
    metadata?: unknown,
  ): Promise<TResponse>;

  invoke(
    name: string,
    method: string,
    methodArgs: unknown[],
    metadata: unknown,
    connect: true,
  ): Promise<TChannel>;
}
export class StubAwaiter<
  TResponse,
  TChannel extends DuplexChannel<any, any>,
> implements
  PromiseLike<
    TResponse
  >,
  DuplexChannel<any, any> {
  ch: Promise<TChannel> | null = null;
  ctrl: AbortController;
  _disconnected: PromiseWithResolvers<{ reconnected: Promise<void> }> = Promise
    .withResolvers();
  constructor(
    protected actorName: string,
    protected actorMethod: string,
    protected methodArgs: unknown[],
    protected invoker: StubInvoker<TResponse, TChannel>,
    protected mMetadata?: unknown,
  ) {
    this.ctrl = new AbortController();
  }
  [Symbol.dispose](): void {
    this.close();
  }
  async close(reason?: any) {
    if (this.ch === null) {
      return;
    }
    const ch = await this.channel;
    await ch.close(reason);
    this.ch = null;
  }
  get signal() {
    return this.ctrl.signal;
  }
  get closed() {
    return this.channel.then((ch) => ch.closed);
  }

  async *recv(signal?: AbortSignal): AsyncIterableIterator<any> {
    const ch = await this.channel;
    const it = ch.recv(signal);
    yield* it;
  }

  private get channel(): Promise<TChannel> {
    if (this.ch) {
      return this.ch;
    }
    const connect = () =>
      this.invoker.invoke(
        this.actorName,
        this.actorMethod,
        this.methodArgs,
        this.mMetadata,
        true,
      );

    const sendChan = makeChan();
    const recvChan = makeChan();
    const reliableCh = makeDuplexChannelWith(sendChan, recvChan) as TChannel;
    const ch = Promise.resolve<TChannel>(reliableCh);
    this.ch = ch;

    const nextConnection = async (onConnected?: () => void): Promise<void> => {
      const ch = await retry(connect, {
        initialDelay: 1e3, // one second of initial delay
        maxAttempts: 30, // 30 attempts
        maxDelay: 10e3, // 10 seconds max delay
      });
      onConnected?.();
      const recvLoop = async () => {
        for await (const val of ch.recv(reliableCh.signal)) {
          recvChan.send(val);
        }
      };
      const sendLoop = async () => {
        for await (const val of sendChan.recv(ch.signal)) {
          ch.send(val);
        }
      };
      await Promise.all([recvLoop(), sendLoop()]);
      if (ch.signal.aborted && !reliableCh.signal.aborted) {
        const prev = this._disconnected;
        this._disconnected = Promise.withResolvers();
        const reconnected = Promise.withResolvers<void>();
        prev.resolve({ reconnected: reconnected.promise });
        console.error("channel closed, retrying...");
        await new Promise((resolve) => setTimeout(resolve, 2e3)); // retrying in 2 second
        return nextConnection(reconnected.resolve).catch(reconnected.reject);
      }
      ch.close();
      this.ch = null;
    };
    nextConnection().catch((err) => {
      console.error(`could not connect to websocket`, err);
    });
    return this.ch;
  }

  get disconnected() {
    return this._disconnected.promise;
  }

  async send(value: unknown): Promise<void> {
    const ch = await this.channel;
    await ch.send(value);
  }

  catch<TResult>(onrejected: Rejected<TResult>): Promise<TResponse | TResult> {
    return this.invoker.invoke(
      this.actorName,
      this.actorMethod,
      this.methodArgs,
      this.mMetadata,
    )
      .catch(onrejected);
  }

  then<TResult1, TResult2 = TResult1>(
    onfufilled?: Fulfilled<
      TResponse,
      TResult1
    >,
    onrejected?: Rejected<TResult2>,
  ): Promise<TResult1 | TResult2> {
    return this.invoker.invoke(
      this.actorName,
      this.actorMethod,
      this.methodArgs,
      this.mMetadata,
    ).then(onfufilled).catch(
      onrejected,
    );
  }
}

/**
 * options to create a new actor proxy.
 */
export interface ProxyOptions<TInstance extends Actor> {
  actor: ActorConstructor<TInstance> | string;
  server: string;
}

export type StubOptions<TInstance extends Actor> = ProxyOptions<TInstance>;

export type PromisifyKey<Actor, key extends keyof Actor> = Actor[key] extends
  (...args: infer Args) => Awaited<infer Return> | Promise<infer Return>
  ? Return extends ChannelUpgrader<infer TSend, infer TReceive> ? {
      (
        ...args: Args
      ): DuplexChannel<TReceive, TSend>;
    }
  : { (...args: Args): Promise<Awaited<Return>> }
  : Actor[key];

export type EnrichMetadataFn<
  TMetadata,
  EnrichedMetadata extends TMetadata = TMetadata,
> = (
  metadata: TMetadata,
  req: Request,
) => EnrichedMetadata;

export interface BaseMetadata {
  signal?: AbortSignal;
}
/**
 * Represents an actor proxy.
 */
export type ActorProxy<Actor> =
  & {
    [key in keyof Omit<Actor, "enrichMetadata" | "metadata">]: PromisifyKey<
      Actor,
      key
    >;
  }
  & (Actor extends { metadata?: infer TMetadata } ? Actor extends {
      enrichMetadata: EnrichMetadataFn<infer TPartialMetadata, any>;
    } ? {
        withMetadata(
          metadata: Omit<TPartialMetadata, keyof BaseMetadata>,
        ): ActorProxy<Actor>;
        rpc(): ActorProxy<Actor> & Disposable;
      }
    : {
      withMetadata(
        metadata: Omit<TMetadata, keyof BaseMetadata>,
      ): ActorProxy<Actor>;
      rpc(): ActorProxy<Actor> & Disposable;
    }
    : { rpc(): ActorProxy<Actor> & Disposable });

export type StubProxy<TInstance> = ActorProxy<TInstance>;

const urlFor = (
  serverUrl: string,
  actor: ActorConstructor | string,
  actorMethod: string,
): string => {
  return `${serverUrl}/actors/${
    typeof actor === "string" ? actor : actor.name
  }/invoke/${actorMethod}`;
};

const IS_BROWSER = typeof document !== "undefined";

let _server: StubServer | null = null;
const isLayeredUrl = (url: string): boolean => url.includes("layers");
const initServer = (): StubServer => {
  if (IS_BROWSER) {
    return {
      url: "", // relative
    };
  }

  const deploymentId = process.env.DENO_DEPLOYMENT_ID;
  const fallbackUrl = typeof deploymentId === "string"
    ? undefined
    : `http://localhost:${process.env.PORT ?? 8000}`;

  return {
    url: process.env.DECO_ACTORS_SERVER_URL ??
      fallbackUrl ?? "",
    deploymentId: deploymentId && isLayeredUrl(deploymentId)
      ? deploymentId
      : undefined,
  };
};

type RequestResolver<TResponse> = {
  response: PromiseWithResolvers<TResponse>;
  stream?: Channel<unknown>;
  ch?: DuplexChannel<unknown, unknown>;
  it?: AsyncIterableIterator<unknown>;
};
export const createRPCInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  channel: DuplexChannel<InvokeRequest, InvokeResponse>,
): StubInvoker<TResponse, TChannel> => {
  // Map to store pending requests
  const pendingRequests = new Map<
    string,
    RequestResolver<TResponse>
  >();

  // Start listening for responses
  (async () => {
    for await (const response of channel.recv()) {
      const resolver = pendingRequests.get(response.id);
      if (!resolver) {
        continue;
      }
      if ("error" in response && !("stream" in response)) {
        pendingRequests.delete(response.id);
        let err;
        if (response.constructorName) {
          // Reconstruct the error if we have constructor information
          const errorData = JSON.parse(response.error as string);
          const error = Object.assign(
            new Error(),
            errorData,
          );
          error.constructor = { name: response.constructorName };
          err = error;
        } else {
          err = response.error;
        }
        resolver.response.reject(err);
        resolver.it?.throw?.(err);
        resolver.stream?.close();
        resolver.ch?.close();
      } else if ("stream" in response) {
        if ("end" in response) {
          if ("error" in response && response.error) {
            await resolver.it?.throw?.(response.error)?.catch?.(console.error);
          }
          resolver.stream?.close();
          pendingRequests.delete(response.id);
        } else if ("start" in response) {
          resolver.stream = makeChan();
          resolver.stream.closed.finally(() => {
            pendingRequests.delete(response.id);
            channel.send({
              id: response.id,
              cancelStream: true,
            });
          });
          const it = resolver.stream.recv(channel.signal);
          const retn = it.return;
          const throwf = it.throw;

          it.return = (val) => {
            const result = retn?.call(it, val) ?? val;
            resolver?.stream?.close();
            return result;
          };

          it.throw = (err) => {
            try {
              const result = throwf?.call(it, err);
              return result ?? err;
            } finally {
              resolver?.stream?.close(err);
            }
          };

          resolver.it = it;
          resolver.response.resolve(
            it as TResponse,
          );
        } else if (resolver.stream) {
          resolver.stream.send(response.result);
        }
      } else if ("channel" in response) {
        if ("close" in response) {
          resolver.ch?.close();
          pendingRequests.delete(response.id);
        } else if ("opened" in response) {
          const recv = makeChan();
          const send = makeChan();
          const chan = makeDuplexChannelWith(send, recv);
          chan.closed.finally(() => {
            pendingRequests.delete(response.id);
            channel.send({
              id: response.id,
              channel: true,
              close: true,
            });
          });
          resolver.stream = recv;
          resolver.ch = chan;
          channel.closed.finally(() => {
            pendingRequests.delete(response.id);
            resolver.stream?.close();
          });

          resolver.response.resolve(chan as TResponse);
          (async () => {
            for await (const message of send.recv(channel.signal)) {
              channel.send({
                id: response.id,
                channel: true,
                message,
              });
            }
          })();
        } else if ("message" in response && resolver.stream) {
          resolver.stream.send(response.message);
        }
      } else {
        resolver.response.resolve(response.result);
      }
    }
  })();

  let seq = 0;
  return {
    invoke: async (name, method, methodArgs, metadata, connect) => {
      const id = `${++seq}`; // we support "only" ~9 quadrillion of messages in a single socket, looks good though :)
      const response = Promise.withResolvers<TResponse>();
      const resolver: RequestResolver<TResponse> = { response };
      pendingRequests.set(id, resolver);
      const cleanup = (errored = false) => {
        if (!pendingRequests.has(id)) {
          return;
        }
        response.reject(ClosedChannelError.instance);
        errored &&
          resolver?.it?.throw?.(ClosedChannelError.instance)?.catch?.(
            console.error,
          );
        resolver.stream?.close();
        resolver.ch?.close();
      };
      channel.closed.finally(cleanup);
      channel.disconnected?.finally(() => cleanup(true));

      try {
        await channel.send({
          id,
          invoke: [name, method, methodArgs, metadata, connect],
        });
        return await response.promise;
      } catch (err) {
        pendingRequests.delete(id);
        throw err;
      }
    },
  } as StubInvoker<TResponse, TChannel>;
};

export interface InvokeHooks {
  useRequest: (request: Request) => Request;
  useWebsocketUrl: (url: URL) => URL;
}

export const createHttpInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  hooks?: InvokeHooks,
  options?: StubServerOptions,
): StubInvoker<TResponse, TChannel> => {
  const server = options?.server;
  if (!server) {
    _server ??= initServer();
  }
  const stubServer = server ?? _server!;
  return {
    invoke: async (
      name,
      method,
      methodArgs,
      metadata,
      connect?: true,
    ) => {
      const endpoint = urlFor(stubServer.url, name, method);
      if (connect) {
        const url = new URL(`${endpoint}?args=${
          encodeURIComponent(
            btoa(
              JSON.stringify({
                args: methodArgs ?? [],
                metadata: metadata ?? {},
              }),
            ),
          )
        }&${
          options?.maxWsChunkSize
            ? `&${STUB_MAX_CHUNK_SIZE_QS_NAME}=${options.maxWsChunkSize}`
            : ""
        }`);
        url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
        const newWS = options?.fetcher?.createWebSocket ??
          ((url: URL | string) => new WebSocket(url));
        const ws = newWS(
          hooks?.useWebsocketUrl?.(url) ?? url,
        );
        return makeWebSocket(ws, options?.maxWsChunkSize) as Promise<TChannel>;
      }
      let body: BodyInit | null | undefined, contentType: string | undefined;
      if (
        Array.isArray(methodArgs) && methodArgs[0] &&
          methodArgs[0] instanceof ReadableStream ||
        methodArgs[0] instanceof Uint8Array
      ) {
        const [stream, ...rest] = methodArgs;
        body = new FormData();
        const blob = new Blob([await readAsBytes(stream)], {
          type: "application/octet-stream",
        });
        body.append("file", blob);
        body.append("metadata", JSON.stringify(metadata ?? {}));
        body.append("args", JSON.stringify(rest ?? []));
      } else {
        body = JSON.stringify(
          {
            args: methodArgs ?? [],
            metadata: metadata ?? {},
          },
          (_key, value) => typeof value === "bigint" ? value.toString() : value, // return everything else unchanged
        );
        contentType = "application/json";
      }
      const abortCtrl = new AbortController();
      const fetcher = options?.fetcher?.fetch ?? fetch;
      const request = new Request(endpoint, {
        method: "POST",
        signal: abortCtrl.signal,
        credentials: stubServer?.credentials,
        headers: {
          ...contentType ? { "Content-Type": contentType } : {},
          ...stubServer.deploymentId
            ? { ["x-deno-deployment-id"]: stubServer.deploymentId }
            : {},
        },
        body,
      });

      const resp = await fetcher(hooks?.useRequest?.(request) ?? request);
      if (!resp.ok) {
        if (resp.status === 404) {
          return undefined;
        }
        const constructorName = resp.headers.get(STUB_CONSTRUCTOR_NAME_HEADER);
        const ErrorConstructor =
          options?.errorHandling?.[constructorName ?? "Error"] ?? Error;
        const errorParameters =
          resp.headers.get("content-type")?.includes("application/json")
            ? await resp.json()
            : {
              message: await resp.text().catch(() =>
                `HTTP Error: ${resp.statusText}`
              ),
            };
        const deserializedError = Object.assign(
          new ErrorConstructor(),
          errorParameters,
        );
        throw deserializedError;
      }
      if (
        resp.headers.get("content-type") ===
          EVENT_STREAM_RESPONSE_HEADER
      ) {
        const iterator = readFromStream(resp);
        const retn = iterator.return;
        iterator.return = function (val) {
          abortCtrl.abort();
          return retn?.call(iterator, val) ?? val;
        };
        return iterator;
      }
      if (resp.status === 204) {
        return;
      }
      if (
        resp.headers.get("content-type")?.includes("application/octet-stream")
      ) {
        // @ts-ignore: cf types mess with typings.
        return new Uint8Array(await resp.arrayBuffer());
      }
      return resp.json() as Promise<any>;
    },
  };
};

export const WELL_KNOWN_RPC_MEHTOD = "_rpc";

export const create = <TInstance, TArgs extends unknown[] = unknown[]>(
  stub: { name: string } | string,
  stubInvokerFactory: (...args: TArgs) => StubInvoker,
  metadata?: unknown,
  disposer?: () => void,
): StubFactory<TInstance, TArgs> => {
  const name = typeof stub === "string" ? stub : stub.name;
  return {
    new: (...args: TArgs): StubProxy<TInstance> => {
      return new Proxy<StubProxy<TInstance>>({} as StubProxy<TInstance>, {
        get: (_, method) => {
          if (method === "withMetadata") {
            return (m: unknown) =>
              create(stub, stubInvokerFactory, m).new(...args);
          }
          if (method === Symbol.dispose && disposer) {
            return disposer;
          }
          const invoker = stubInvokerFactory(...args);
          if (method === "rpc") {
            return () => {
              const awaiter = new StubAwaiter(
                name,
                WELL_KNOWN_RPC_MEHTOD,
                [],
                invoker,
                metadata,
              );
              const rpcInvoker = createRPCInvoker(awaiter);
              return create<TInstance, TArgs>(
                stub,
                () => rpcInvoker,
                undefined,
                () => awaiter.close(),
              ).new(
                ...args,
              );
            };
          }
          return (...args: unknown[]) => {
            const awaiter = new StubAwaiter(
              name,
              String(method),
              args,
              invoker,
              metadata,
            );
            return awaiter;
          };
        },
      });
    },
  };
};
