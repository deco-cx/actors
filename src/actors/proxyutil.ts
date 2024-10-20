import type { ActorsOptions, ActorsServer } from "./proxy.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "./stream.ts";
import {
  type ChannelUpgrader,
  type DuplexChannel,
  makeWebSocket,
} from "./util/channels/channel.ts";

export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";
export const ACTOR_ID_QS_NAME = "deno_isolate_instance_id";
export const ACTOR_CONSTRUCTOR_NAME_HEADER = "x-error-constructor-name";
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
    protected mMetadata?: unknown,
  ) {
  }
  [Symbol.dispose](): void {
    this.close();
  }
  async close() {
    const ch = await this.channel;
    await ch.close();
  }
  get signal() {
    return new AbortSignal();
  }
  get closed() {
    return this.channel.then((ch) => ch.closed);
  }

  async *recv(signal?: AbortSignal): AsyncIterableIterator<unknown> {
    const ch = await this.channel;
    yield* ch.recv(signal);
  }

  private get channel(): Promise<TChannel> {
    return this.ch ??= this.invoker.invoke(
      this.actorName,
      this.actorMethod,
      this.methodArgs,
      this.mMetadata,
      true,
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

export const createHttpInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  actorId: string,
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
        const ws = new WebSocket(
          `${endpoint}?args=${
            encodeURIComponent(
              btoa(
                JSON.stringify({
                  args: methodArgs ?? [],
                  metadata: metadata ?? {},
                }),
              ),
            )
          }&${ACTOR_ID_QS_NAME}=${actorId}`,
        );
        return makeWebSocket(ws) as Promise<TChannel>;
      }
      const abortCtrl = new AbortController();
      const resp = await fetch(
        endpoint,
        {
          method: "POST",
          signal: abortCtrl.signal,
          headers: {
            "Content-Type": "application/json",
            [ACTOR_ID_HEADER_NAME]: actorId,
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
        return new Uint8Array(await resp.arrayBuffer());
      }
      return resp.json();
    },
  };
};

export const create = <TInstance extends Actor>(
  actor: ActorConstructor<TInstance> | string,
  invokerFactory: (id: string) => ActorInvoker,
  metadata?: unknown,
): { id: (id: string) => ActorProxy<TInstance> } => {
  const name = typeof actor === "string" ? actor : actor.name;
  return {
    id: (id: string): ActorProxy<TInstance> => {
      return new Proxy<ActorProxy<TInstance>>({} as ActorProxy<TInstance>, {
        get: (_, method) => {
          if (method === "withMetadata") {
            return (m: unknown) => create(actor, invokerFactory, m).id(id);
          }
          const invoker = invokerFactory(id);
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
