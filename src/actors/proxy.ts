import {
  type ChannelUpgrader,
  type DuplexChannel,
  makeWebSocket,
} from "./channels/channel.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "./stream.ts";

export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";
export const ACTOR_ID_QS_NAME = "x-deno-isolate-instance-id";
/**
 * Promise.prototype.then onfufilled callback type.
 */
export type Fulfilled<R, T> = ((result: R) => T | PromiseLike<T>) | null;

/**
 * Promise.then onrejected callback type.
 */
// deno-lint-ignore no-explicit-any
export type Rejected<E> = ((reason: any) => E | PromiseLike<E>) | null;

export class ActorAwaiter<
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
> implements
  PromiseLike<
    TResponse
  >,
  DuplexChannel<unknown, unknown> {
  ch: Promise<TChannel> | null = null;
  constructor(
    protected fetcher: () => Promise<
      TResponse
    >,
    protected ws: () => Promise<TChannel>,
  ) {
  }
  async close() {
    const ch = await this.channel;
    await ch.close();
  }

  async *recv(signal?: AbortSignal): AsyncIterableIterator<unknown> {
    const ch = await this.channel;
    yield* ch.recv(signal);
  }

  private get channel(): Promise<TChannel> {
    return this.ch ??= this.ws();
  }

  async send(value: unknown): Promise<void> {
    const ch = await this.channel;
    await ch.send(value);
  }

  catch<TResult>(onrejected: Rejected<TResult>): Promise<TResponse | TResult> {
    return this.fetcher().catch(onrejected);
  }

  then<TResult1, TResult2 = TResult1>(
    onfufilled?: Fulfilled<
      TResponse,
      TResult1
    >,
    onrejected?: Rejected<TResult2>,
  ): Promise<TResult1 | TResult2> {
    return this.fetcher().then(onfufilled).catch(
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

type PromisifyKey<key extends keyof Actor, Actor> = Actor[key] extends
  (...args: infer Args) => Awaited<infer Return>
  ? Return extends ChannelUpgrader<infer TSend, infer TReceive>
    ? (...args: Args) => DuplexChannel<TSend, TReceive>
  : (...args: Args) => Promise<Return>
  : Actor[key];

type Promisify<Actor> = {
  [key in keyof Actor]: PromisifyKey<key, Actor>;
};

export interface ActorsServer {
  url: string;
  deploymentId?: string;
}

const IS_BROWSER = typeof document !== "undefined";

let _server: ActorsServer | null = null;
const isLayeredUrl = (url: string): boolean => url.includes("layers");
const initServer = (): ActorsServer => {
  if (IS_BROWSER) {
    return {
      url: "", // relative
    };
  }

  const deploymentId = Deno.env.get("DENO_DEPLOYMENT_ID");
  const fallbackUrl = typeof deploymentId === "string"
    ? undefined
    : `http://localhost:${Deno.env.get("PORT") ?? 8000}`;

  return {
    url: Deno.env.get(
      "DECO_ACTORS_SERVER_URL",
    ) ??
      fallbackUrl ?? "",
    deploymentId: deploymentId && isLayeredUrl(deploymentId)
      ? deploymentId
      : undefined,
  };
};

/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    server?: ActorsServer | undefined,
  ): { id: (id: string) => Promisify<TInstance> } => {
    if (!server) {
      _server ??= initServer();
    }
    const actorsServer = server ?? _server!;
    return {
      id: (id: string): Promisify<TInstance> => {
        return new Proxy<Promisify<TInstance>>({} as Promisify<TInstance>, {
          get: (_, prop) => {
            const endpoint = `${actorsServer.url}/actors/${
              typeof actor === "string" ? actor : actor.name
            }/invoke/${String(prop)}`;
            const fetcher = async (...args: unknown[]) => {
              const abortCtrl = new AbortController();
              const resp = await fetch(
                endpoint,
                {
                  method: "POST",
                  signal: abortCtrl.signal,
                  headers: {
                    "Content-Type": "application/json",
                    [ACTOR_ID_HEADER_NAME]: id,
                    ...actorsServer.deploymentId
                      ? { ["x-deno-deployment-id"]: actorsServer.deploymentId }
                      : {},
                  },
                  body: JSON.stringify({
                    args: args ?? [],
                  }),
                },
              );
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
              return resp.json();
            };
            return (...args: unknown[]) => {
              const awaiter = new ActorAwaiter(() => fetcher(...args), () => {
                const ws = new WebSocket(
                  `${endpoint}?args=${
                    encodeURIComponent(
                      btoa(JSON.stringify({ args: args ?? [] })),
                    )
                  }&${ACTOR_ID_QS_NAME}=${id}`,
                );
                return makeWebSocket(ws);
              });
              return awaiter;
            };
          },
        });
      },
    };
  },
};
