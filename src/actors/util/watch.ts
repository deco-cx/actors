export type { ChannelUpgrader } from "./channels/channel.ts";
/**
 * Watches events and returns async iterators for the events.
 */
export class WatchTarget<T> {
  private subscribers: Record<string, (value: T) => void> = {};

  // Subscribe to changes and get an async iterator
  subscribe(signal?: AbortSignal): AsyncIterableIterator<T> {
    const subscriptionId = crypto.randomUUID();
    const queue: Array<(value: IteratorResult<T>) => void> = [];

    const pushQueue = (value: IteratorResult<T>) => {
      queue.forEach((resolve) => resolve(value));
    };

    const nextPromise = () =>
      new Promise<IteratorResult<T>>((resolve) => {
        queue.push((v) => {
          if (signal?.aborted) {
            return resolve({ value: undefined, done: true });
          }
          resolve(v);
        });
      });

    const iterator: AsyncIterableIterator<T> = {
      next: () => nextPromise(),
      return: () => {
        // Clean up the subscription when the consumer is done
        delete this.subscribers[subscriptionId];
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    this.subscribers[subscriptionId] = (value: T) => {
      pushQueue({ value, done: false });
    };
    signal?.addEventListener("abort", () => {
      iterator?.return?.();
    });

    return iterator;
  }

  // Notify all subscribers with the new value
  notify(value: T): void {
    Object.values(this.subscribers).forEach((subscriber) => subscriber(value));
  }
}
