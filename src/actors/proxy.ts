import { create, createHttpInvoker, type Promisify } from "./proxyutil.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";

export interface ActorsServer {
  url: string;
  deploymentId?: string;
}

/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    server?: ActorsServer | undefined,
  ): { id: (id: string) => Promisify<TInstance> } => {
    const factory = (id: string) => createHttpInvoker(id, server);
    return create(actor, factory);
  },
};
