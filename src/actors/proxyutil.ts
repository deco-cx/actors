// deno-lint-ignore-file no-explicit-any
import process from "node:process";
import type { ActorsOptions, ActorsServer } from "./proxy.ts";
import type { InvokeRequest, InvokeResponse } from "./rpc.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "./stream.ts";
import {
  type Channel,
  type ChannelUpgrader,
  type DuplexChannel,
  makeChan,
  makeDuplexChannelWith,
  makeWebSocket,
} from "./util/channels/channel.ts";
import { retry } from "./util/retry.ts";

export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";
export const ACTOR_ID_QS_NAME = "deno_isolate_instance_id";
export const ACTOR_CONSTRUCTOR_NAME_HEADER = "x-error-constructor-name";
export const ACTOR_DISCRIMINATOR_HEADER_NAME = "x-actor-discriminator";
export const ACTOR_DISCRIMINATOR_QS_NAME = "actor_discriminator";

export type ProxyFactory<TInstance> = (
  id: string,
  discriminator?: string,
) => ActorProxy<TInstance>;
/**
 * Promise.prototype.then onfufilled callback type.
 */
export type Fulfilled<R, T> = ((result: R) => T | PromiseLike<T>) | null;

/**
 * Promise.then onrejected callback type.
 */
export type Rejected<E> = ((reason: any) => E | PromiseLike<E>) | null;

export interface ActorInvoker<
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
export class ActorAwaiter<
  TResponse,
  TChannel extends DuplexChannel<any, any>,
> implements
  PromiseLike<
    TResponse
  >,
  DuplexChannel<any, any> {
  ch: Promise<TChannel> | null = null;
  ctrl: AbortController;
  _disconnected: PromiseWithResolvers<void> = Promise.withResolvers();
  constructor(
    protected actorName: string,
    protected actorMethod: string,
    protected methodArgs: unknown[],
    protected invoker: ActorInvoker<TResponse, TChannel>,
    protected mMetadata?: unknown,
  ) {
    this.ctrl = new AbortController();
  }
  [Symbol.dispose](): void {
    this.close();
  }
  async close() {
    const ch = await this.channel;
    await ch.close();
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
    const retn = it.return;
    it.return = (val) => {
      ch.close();
      this.ch = null;
      return retn?.call(it, val) ?? val;
    };
    yield* it;
  }

  private get channel(): Promise<TChannel> {
    if (this.ch) {
      return this.ch;
    }
    const sendChan = makeChan();
    const recvChan = makeChan();
    const reliableCh = makeDuplexChannelWith(sendChan, recvChan) as TChannel;
    const ch = Promise.resolve<TChannel>(reliableCh);
    this.ch = ch;

    const connect = () =>
      this.invoker.invoke(
        this.actorName,
        this.actorMethod,
        this.methodArgs,
        this.mMetadata,
        true,
      );
    const nextConnection = async () => {
      const ch = await retry(connect, {
        initialDelay: 1e3, // one second of initial delay
        maxAttempts: 30, // 30 attempts
        maxDelay: 10e3, // 10 seconds max delay
      });
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
        prev.resolve();
        console.error("channel closed, retrying...");
        await new Promise((resolve) => setTimeout(resolve, 2e3)); // retrying in 2 second
        return nextConnection();
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

export type PromisifyKey<Actor, key extends keyof Actor> = Actor[key] extends
  (...args: infer Args) => Awaited<infer Return>
  ? Return extends ChannelUpgrader<infer TSend, infer TReceive>
    ? { (...args: Args): DuplexChannel<TReceive, TSend> }
  : { (...args: Args): Promise<Awaited<Return>> }
  : Actor[key];

/**
 * Represents an actor proxy.
 */
export type ActorProxy<Actor> =
  & {
    [key in keyof Actor]: PromisifyKey<Actor, key>;
  }
  & (Actor extends { metadata?: infer TMetadata } ? {
      withMetadata(metadata: TMetadata): ActorProxy<Actor>;
      rpc(): ActorProxy<Actor> & Disposable;
    }
    // deno-lint-ignore ban-types
    : {});

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

let _server: ActorsServer | null = null;
const isLayeredUrl = (url: string): boolean => url.includes("layers");
const initServer = (): ActorsServer => {
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
};
export const createRPCInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  channel: DuplexChannel<InvokeRequest, InvokeResponse>,
): ActorInvoker<TResponse, TChannel> => {
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
      if ("error" in response) {
        pendingRequests.delete(response.id);
        if (response.constructorName) {
          // Reconstruct the error if we have constructor information
          const errorData = JSON.parse(response.error as string);
          const error = Object.assign(
            new Error(),
            errorData,
          );
          error.constructor = { name: response.constructorName };
          resolver.response.reject(error);
        } else {
          resolver.response.reject(response.error);
        }
      } else if ("stream" in response) {
        if ("end" in response) {
          resolver.stream?.close();
          pendingRequests.delete(response.id);
        } else if ("start" in response) {
          resolver.stream = makeChan();
          const it = resolver.stream.recv(channel.signal);
          const retn = it.return;
          it.return = (val) => {
            return retn?.call(it, val) ?? val;
          };
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
              closeChannel: true,
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

  return {
    invoke: async (name, method, methodArgs, metadata, connect) => {
      const id = crypto.randomUUID();
      const response = Promise.withResolvers<TResponse>();
      const resolver: RequestResolver<TResponse> = { response };
      pendingRequests.set(id, resolver);
      const cleanup = () => {
        response.reject(new Error("Channel closed"));
      };
      channel.closed.finally(cleanup);
      channel.disconnected?.finally(cleanup);

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
  } as ActorInvoker<TResponse, TChannel>;
};

export const createHttpInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  actorId: string,
  discriminator?: string,
  options?: ActorsOptions,
): ActorInvoker<TResponse, TChannel> => {
  const server = options?.server;
  if (!server) {
    _server ??= initServer();
  }
  const actorsServer = server ?? _server!;
  return {
    invoke: async (name, method, methodArgs, metadata, connect?: true) => {
      const endpoint = urlFor(actorsServer.url, name, method);
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
        }&${ACTOR_ID_QS_NAME}=${actorId}${
          discriminator
            ? `&${ACTOR_DISCRIMINATOR_QS_NAME}=${discriminator}`
            : ""
        }`);
        url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
        const ws = new WebSocket(
          url,
        );
        return makeWebSocket(ws) as Promise<TChannel>;
      }
      const abortCtrl = new AbortController();
      const resp = await fetch(
        endpoint,
        {
          method: "POST",
          signal: abortCtrl.signal,
          credentials: actorsServer?.credentials,
          headers: {
            "Content-Type": "application/json",
            [options?.actorIdHeaderName ?? ACTOR_ID_HEADER_NAME]: actorId,
            ...discriminator
              ? { [ACTOR_DISCRIMINATOR_HEADER_NAME]: discriminator }
              : {},
            ...actorsServer.deploymentId
              ? { ["x-deno-deployment-id"]: actorsServer.deploymentId }
              : {},
          },
          body: JSON.stringify(
            {
              args: methodArgs ?? [],
              metadata: metadata ?? {},
            },
            (_key, value) =>
              typeof value === "bigint" ? value.toString() : value, // return everything else unchanged
          ),
        },
      );
      if (!resp.ok) {
        if (resp.status === 404) {
          return undefined;
        }
        const constructorName = resp.headers.get(ACTOR_CONSTRUCTOR_NAME_HEADER);
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
export const create = <TInstance extends Actor>(
  actor: ActorConstructor<TInstance> | string,
  invokerFactory: (id: string, discriminator?: string) => ActorInvoker,
  metadata?: unknown,
  disposer?: () => void,
): { id: ProxyFactory<TInstance> } => {
  const name = typeof actor === "string" ? actor : actor.name;
  return {
    id: (id: string, discriminator?: string): ActorProxy<TInstance> => {
      return new Proxy<ActorProxy<TInstance>>({} as ActorProxy<TInstance>, {
        get: (_, method) => {
          if (method === "withMetadata") {
            return (m: unknown) =>
              create(actor, invokerFactory, m).id(id, discriminator);
          }
          if (method === Symbol.dispose && disposer) {
            return disposer;
          }
          const invoker = invokerFactory(id, discriminator);
          if (method === "rpc") {
            return () => {
              const awaiter = new ActorAwaiter(
                name,
                WELL_KNOWN_RPC_MEHTOD,
                [],
                invoker,
                metadata,
              );
              const rpcInvoker = createRPCInvoker(awaiter);
              return create(
                actor,
                () => rpcInvoker,
                metadata,
                () => awaiter.close(),
              ).id(
                id,
                discriminator,
              );
            };
          }
          return (...args: unknown[]) => {
            const awaiter = new ActorAwaiter(
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
