import { create, createHttpInvoker, type Promisify } from "./proxyutil.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";

export interface ActorsServer {
  url: string;
  deploymentId?: string;
}

export interface ActorsOptions {
  server?: ActorsServer;
  errorHandling?: Record<string, new (...args: unknown[]) => Error>;
}
/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    options?: ActorsOptions | undefined,
  ): { id: (id: string) => Promisify<TInstance> } => {
    const factory = (id: string) => createHttpInvoker(id, options);
    return create(actor, factory);
  },
};
