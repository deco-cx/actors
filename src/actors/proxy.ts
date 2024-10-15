import type { Actor, ActorConstructor } from "./runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "./stream.ts";
import {
  type ChannelUpgrader,
  type DuplexChannel,
  makeWebSocket,
} from "./util/channels/channel.ts";

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

export interface ActorInvoker<
  // deno-lint-ignore no-explicit-any
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
  ): Promise<TResponse>;

  connect(
    name: string,
    method: string,
    methodArgs: unknown[],
  ): Promise<TChannel>;
}
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
    protected actorName: string,
    protected actorMethod: string,
    protected methodArgs: unknown[],
    protected invoker: ActorInvoker<TResponse, TChannel>,
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
    return this.ch ??= this.invoker.connect(
      this.actorName,
      this.actorMethod,
      this.methodArgs,
    );
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

const urlFor = (
  serverUrl: string,
  actor: ActorConstructor | string,
  actorMethod: string,
): string => {
  return `${serverUrl}/actors/${
    typeof actor === "string" ? actor : actor.name
  }/invoke/${actorMethod}`;
};

const createHttpInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  actorId: string,
  server: ActorsServer,
): ActorInvoker<TResponse, TChannel> => {
  return {
    connect: (name, method, methodArgs) => {
      const endpoint = urlFor(server.url, name, method);
      const ws = new WebSocket(
        `${endpoint}?args=${
          encodeURIComponent(
            btoa(JSON.stringify({ args: methodArgs ?? [] })),
          )
        }&${ACTOR_ID_QS_NAME}=${actorId}`,
      );
      return makeWebSocket(ws) as Promise<TChannel>;
    },
    invoke: async (name, method, methodArgs) => {
      const endpoint = urlFor(server.url, name, method);
      const abortCtrl = new AbortController();
      const resp = await fetch(
        endpoint,
        {
          method: "POST",
          signal: abortCtrl.signal,
          headers: {
            "Content-Type": "application/json",
            [ACTOR_ID_HEADER_NAME]: actorId,
            ...server.deploymentId
              ? { ["x-deno-deployment-id"]: server.deploymentId }
              : {},
          },
          body: JSON.stringify({
            args: methodArgs ?? [],
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
    },
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
    const name = typeof actor === "string" ? actor : actor.name;
    return {
      id: (id: string): Promisify<TInstance> => {
        return new Proxy<Promisify<TInstance>>({} as Promisify<TInstance>, {
          get: (_, method) => {
            const invoker = createHttpInvoker(id, actorsServer);
            return (...args: unknown[]) => {
              const awaiter = new ActorAwaiter(
                name,
                String(method),
                args,
                invoker,
              );
              return awaiter;
            };
          },
        });
      },
    };
  },
};
