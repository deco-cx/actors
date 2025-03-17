// deno-lint-ignore-file no-explicit-any
import type { Actor, ActorConstructor } from "../runtime.ts";
import {
  type ActorProxy,
  create,
  createHttpInvoker,
  type StubFactory,
  type StubInvoker,
} from "../stub/stubutil.ts";
import type { DuplexChannel } from "../util/watch.ts";

export type { ActorProxy, ActorProxy as ActorStub };
export interface StubServer {
  url: string;
  credentials?: RequestCredentials;
  deploymentId?: string;
}

export interface StubFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  createWebSocket: (url: string | URL) => WebSocket;
}

export interface StubServerOptions {
  server?: StubServer;
  errorHandling?: Record<string, new (...args: any[]) => Error>;
  maxWsChunkSize?: number;
  fetcher?: StubFetcher;
}

export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";
export const ACTOR_ID_QS_NAME = "deno_isolate_instance_id";

export const createActorHttpInvoker = <
  TResponse,
  TChannel extends DuplexChannel<unknown, unknown>,
>(
  actorId: string,
  options?: StubServerOptions,
): StubInvoker<TResponse, TChannel> => {
  return createHttpInvoker({
    useRequest: (request) => {
      request.headers.set(ACTOR_ID_HEADER_NAME, actorId);
      return request;
    },
    useWebsocketUrl: (url) => {
      url.searchParams.set(ACTOR_ID_QS_NAME, actorId);
      return url;
    },
  }, options);
};

/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    options?: StubServerOptions | undefined,
  ): StubFactory<TInstance, [string]> => {
    const factory = (id: string) => createActorHttpInvoker(id, options);
    return create(actor, factory);
  },
  stub: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    options?: StubServerOptions | undefined,
  ): StubFactory<TInstance, [string]> => {
    return actors.proxy(actor, options);
  },
};
