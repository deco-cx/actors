import type { WaitGroup } from "@core/asyncutil/wait-group";
import type { ActorStorage } from "./storage.ts";

export interface ActorStateOptions {
  initialization: PromiseWithResolvers<void>;
  respWaitGroup: WaitGroup;
  storage: ActorStorage;
}
export class ActorState {
  public storage: ActorStorage;
  constructor(private options: ActorStateOptions) {
    this.storage = options.storage;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.options.respWaitGroup.add(1);
    try {
      promise.finally(() => {
        this.options.respWaitGroup.done();
      });
    } catch (err) {
      this.options.respWaitGroup.done();
      throw err;
    }
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return await callback().finally(() => {
      this.options.initialization.resolve();
    });
  }
}
