import type { Actor, ActorConstructor } from "./runtime.ts";
import type { ActorStorage } from "./storage.ts";
import type { StubServerOptions } from "./stub/stub.ts";
import type { create } from "./stub/stubutil.ts";

export interface ActorStateOptions {
  id: string;
  storage: ActorStorage;
  stub: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance>,
    options?: StubServerOptions,
  ) => ReturnType<typeof create<TInstance, [string]>>;
}
/**
 * Represents the state of an actor.
 */
export class ActorState {
  public id: string;
  public storage: ActorStorage;
  public stub: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance>,
    options?: StubServerOptions,
  ) => ReturnType<typeof create<TInstance, [string]>>;
  public initialization: Promise<void> = Promise.resolve();
  constructor(options: ActorStateOptions) {
    this.storage = options.storage;
    this.stub = options.stub;
    this.id = options.id;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = callback();
    this.initialization = result.then(() => {});
    return result;
  }
}
