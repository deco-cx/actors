import type { create } from "./proxyutil.ts";
import type { Actor, ActorConstructor } from "./runtime.ts";
import type { ActorStorage } from "./storage.ts";

export interface ActorStateOptions {
  id: string;
  storage: ActorStorage;
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance>,
  ) => ReturnType<typeof create<TInstance>>;
}
/**
 * Represents the state of an actor.
 */
export class ActorState {
  public id: string;
  public storage: ActorStorage;
  public proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance>,
  ) => ReturnType<typeof create<TInstance>>;
  public initialization: Promise<void> = Promise.resolve();
  constructor(options: ActorStateOptions) {
    this.storage = options.storage;
    this.proxy = options.proxy;
    this.id = options.id;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = callback();
    this.initialization = result.then(() => {});
    return result;
  }
}
