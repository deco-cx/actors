// deno-lint-ignore-file no-explicit-any
import {
  type ActorProxy,
  create,
  createHttpInvoker,
  type ProxyFactory,
} from "./proxyutil.ts";
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
  ): { id: ProxyFactory<TInstance> } => {
    const factory = (id: string, discriminator?: string) =>
      createHttpInvoker(id, discriminator, options);
    return create(actor, factory);
  },
};
