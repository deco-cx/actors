// deno-lint-ignore-file no-explicit-any
import { type ActorProxy, create, createHttpInvoker } from "./proxyutil.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";
export type { ActorProxy };
export interface ActorsServer {
  url: string;
  credentials?: RequestCredentials;
  deploymentId?: string;
}

export interface ActorsOptions {
  server?: ActorsServer;
  actorIdHeaderName?: string;
  errorHandling?: Record<string, new (...args: any[]) => Error>;
}
/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    options?: ActorsOptions | undefined,
  ): { id: (id: string) => ActorProxy<TInstance> } => {
    const factory = (id: string) => createHttpInvoker(id, options);
    return create(actor, factory);
  },
};
