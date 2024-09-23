import type { ActorStorage } from "./storage.ts";

export interface ActorStateOptions {
  initialization: PromiseWithResolvers<void>;
  storage: ActorStorage;
}
export class ActorState {
  public storage: ActorStorage;
  constructor(private options: ActorStateOptions) {
    this.storage = options.storage;
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return await callback().finally(() => {
      this.options.initialization.resolve();
    });
  }
}
