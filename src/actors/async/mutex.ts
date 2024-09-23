export class Mutex {
  private _queue: (() => void)[] = [];
  private _locked = false;

  // Returns an unlock function that can be called to release the lock
  lock(): Disposable {
    const unlockNext = () => {
      if (this._queue.length > 0) {
        const nextUnlock = this._queue.shift();
        if (nextUnlock) {
          nextUnlock();
        }
      } else {
        this._locked = false;
      }
    };

    if (this._locked) {
      const waitUnlock = new Promise<void>((resolve) => {
        this._queue.push(() => {
          this._locked = true;
          resolve();
        });
      });

      // Wait for the lock to be available
      waitUnlock.then(() => unlockNext);
    } else {
      this._locked = true;
    }

    return {
      [Symbol.dispose]: () => {
        return unlockNext();
      },
    };
  }

  // Waits until the lock is available
  wait(): Promise<void> {
    if (!this._locked) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this._queue.push(() => {
        this._locked = true;
        resolve();
      });
    });
  }
}
