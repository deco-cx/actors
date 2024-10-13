export class RwLock {
  private readers: number = 0; // Number of readers holding the lock
  private writer: boolean = false; // Whether a writer holds the lock
  private writeQueue: Array<() => void> = []; // Queue of waiting writers
  private readQueue: Array<() => void> = []; // Queue of waiting readers

  // Acquire the read lock
  async rLock(): Promise<Disposable> {
    if (this.writer || this.writeQueue.length > 0) {
      // If there is a writer or writers waiting, wait for the writer to release
      await new Promise<void>((resolve) => this.readQueue.push(resolve));
    }
    this.readers++;
    return {
      [Symbol.dispose]: () => {
        this.rUnlock();
      },
    };
  }

  // Release the read lock
  rUnlock(): void {
    this.readers--;
    this.checkRelease();
  }

  // Acquire the write lock
  async lock(): Promise<Disposable> {
    if (this.writer || this.readers > 0) {
      // If there's a writer or any readers, wait for them to release
      await new Promise<void>((resolve) => this.writeQueue.push(resolve));
    }
    this.writer = true;
    return {
      [Symbol.dispose]: () => {
        this.unlock();
      },
    };
  }

  // Release the write lock
  unlock(): void {
    this.writer = false;
    this.checkRelease();
  }

  // Check if any waiting readers or writers should be released
  private checkRelease(): void {
    if (this.writer || this.readers > 0) {
      // If there's a writer or readers, don't release anyone else
      return;
    }

    // If writers are queued, release the first writer
    if (this.writeQueue.length > 0) {
      const resolve = this.writeQueue.shift()!;
      resolve();
      this.writer = true;
    } else {
      // If readers are queued and no writers are waiting, release all readers
      while (this.readQueue.length > 0) {
        const resolve = this.readQueue.shift()!;
        resolve();
        this.readers++;
      }
    }
  }
}
