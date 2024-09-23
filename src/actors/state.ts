import type { Mutex } from "./async/mutex.ts";
import type { ActorStorage } from "./storage.ts";

export interface ActorStateOptions {
  reqMu: Mutex;
  respMu: Mutex;
  storage: ActorStorage;
}
export class ActorState {
  public storage: ActorStorage;
  constructor(private options: ActorStateOptions) {
    this.storage = options.storage;
  }

  waitUntil(promise: Promise<unknown>): void {
    const disposable = this.options.respMu.lock();
    try {
      promise.finally(() => {
        disposable[Symbol.dispose]();
      });
    } catch (err) {
      disposable[Symbol.dispose]();
      throw err;
    }
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const disposable = this.options.reqMu.lock();
    try {
      return callback().finally(() => {
        disposable[Symbol.dispose]();
      });
    } catch (err) {
      disposable[Symbol.dispose]();
      throw err;
    }
  }
}
