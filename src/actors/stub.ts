// deno-lint-ignore-file no-explicit-any
import type { Actor, ActorConstructor } from "./runtime.ts";
import {
  type ActorProxy,
  create,
  createHttpInvoker,
  type StubFactory,
} from "./stubutil.ts";
export type { ActorProxy, ActorProxy as ActorStub };
export interface ActorsServer {
  url: string;
  credentials?: RequestCredentials;
  deploymentId?: string;
}

export interface ActorFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  createWebSocket: (url: string | URL) => WebSocket;
}

export interface ActorsOptions {
  server?: ActorsServer;
  actorIdHeaderName?: string;
  errorHandling?: Record<string, new (...args: any[]) => Error>;
  maxWsChunkSize?: number;
  fetcher?: ActorFetcher;
}

/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    options?: ActorsOptions | undefined,
  ): { id: StubFactory<TInstance> } => {
    const factory = (id: string, discriminator?: string) =>
      createHttpInvoker(id, discriminator, options);
    return create(actor, factory);
  },
  stub: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    options?: ActorsOptions | undefined,
  ): { id: StubFactory<TInstance> } => {
    return actors.proxy(actor, options);
  },
};
