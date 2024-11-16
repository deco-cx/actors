// deno-lint-ignore-file no-explicit-any
/**
 * A queue implementation that allows for adding and removing elements, with optional waiting when
 * popping elements from an empty queue.
 */
export class Queue<T extends NonNullable<unknown> | null> {
  #head = 0;
  #tail = 0;
  #buffer: T[];
  #capacity: number;
  #waiters: Array<[(value: T) => void, (reason: any) => void]> = [];

  constructor(initialCapacity = 16) {
    this.#capacity = initialCapacity;
    this.#buffer = new Array(initialCapacity);
  }

  /**
   * Gets the number of items in the queue.
   */
  get size(): number {
    return this.#tail - this.#head;
  }

  /**
   * Returns true if the queue has waiting consumers.
   */
  get locked(): boolean {
    return this.#waiters.length > 0;
  }

  /**
   * Adds an item to the end of the queue and notifies any waiting consumers.
   */
  push(value: T): void {
    if (this.#waiters.length > 0) {
      // If there are waiters, directly resolve the first one
      const [resolve] = this.#waiters.shift()!;
      resolve(value);
      return;
    }

    if (this.#tail - this.#head === this.#capacity) {
      // Grow the buffer if needed
      this.#grow();
    }

    this.#buffer[this.#tail++ & (this.#capacity - 1)] = value;
  }

  /**
   * Removes the next item from the queue, optionally waiting if the queue is currently empty.
   */
  pop({ signal }: { signal?: AbortSignal } = {}): Promise<T> {
    if (this.#head < this.#tail) {
      // Fast path: queue has items
      const value = this.#buffer[this.#head++ & (this.#capacity - 1)];

      // Reset indices if queue is empty to prevent overflow
      if (this.#head === this.#tail) {
        this.#head = this.#tail = 0;
      }

      return Promise.resolve(value);
    }

    // Slow path: queue is empty, need to wait
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      const waiter: [(value: T) => void, (reason: any) => void] = [
        resolve,
        reject,
      ];
      this.#waiters.push(waiter);

      if (signal) {
        const abortHandler = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index !== -1) {
            this.#waiters.splice(index, 1);
            reject(signal.reason);
          }
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  #grow(): void {
    const newCapacity = this.#capacity * 2;
    const newBuffer = new Array(newCapacity);

    for (let i = 0; i < this.#capacity; i++) {
      newBuffer[i] = this.#buffer[(this.#head + i) & (this.#capacity - 1)];
    }

    this.#buffer = newBuffer;
    this.#head = 0;
    this.#tail = this.#capacity;
    this.#capacity = newCapacity;
  }
}
