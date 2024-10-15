import type { ActorStorage } from "./storage.ts";

export interface ActorStateOptions {
  storage: ActorStorage;
}
/**
 * Represents the state of an actor.
 */
export class ActorState {
  public storage: ActorStorage;
  public initialization: Promise<void> = Promise.resolve();
  constructor(private options: ActorStateOptions) {
    this.storage = options.storage;
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = callback();
    this.initialization = result.then(() => {});
    return result;
  }
}
