export type { ChannelUpgrader, DuplexChannel } from "./channels/channel.ts";
/**
 * Watches events and returns async iterators for the events.
 */
export class WatchTarget<T> {
  private subscribers: Record<string, (value: T) => void> = {};

  // Subscribe to changes and get an async iterator
  subscribe(signal?: AbortSignal): AsyncIterableIterator<T> {
    const subscriptionId = crypto.randomUUID();
    const queue: Array<(value: IteratorResult<T>) => void> = [];
    let isCancelled = false;

    const pushQueue = (value: IteratorResult<T>) => {
      queue.forEach((resolve) => resolve(value));
    };

    const nextPromise = () =>
      new Promise<IteratorResult<T>>((resolve) => {
        // If already cancelled, resolve immediately
        if (isCancelled || signal?.aborted) {
          return resolve({ value: undefined, done: true });
        }

        // Push a new handler to the queue to resolve when a value is emitted
        queue.push((v) => resolve(v));

        // Listen for the abort signal and resolve immediately if it happens
        signal?.addEventListener(
          "abort",
          () => {
            isCancelled = true;
            resolve({ value: undefined, done: true });
          },
          { once: true }, // Only fire once on the first abort
        );
      });

    const iterator: AsyncIterableIterator<T> = {
      next: () => nextPromise(),
      return: () => {
        // Clean up the subscription when the consumer is done
        isCancelled = true;
        delete this.subscribers[subscriptionId];
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    // If the signal is already aborted at the time of subscription, return immediately
    if (signal?.aborted) {
      iterator?.return?.(); // Clean up immediately
      return iterator;
    }

    this.subscribers[subscriptionId] = (value: T) => {
      pushQueue({ value, done: false });
    };

    // Handle the signal being aborted after subscription
    signal?.addEventListener("abort", () => {
      iterator?.return?.(); // Immediately cancel the iterator
    });

    return iterator;
  }

  // Notify all subscribers with the new value
  notify(value: T): void {
    Object.values(this.subscribers).forEach((subscriber) => subscriber(value));
  }
}
