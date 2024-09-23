export class Gate {
  private lockCount: number = 0;
  private resolveQueue: (() => void)[] = [];

  open(): Promise<void> {
    if (this.lockCount > 0) {
      // If there are locks, wait until the gate is unlocked
      return new Promise<void>((resolve) => {
        this.resolveQueue.push(resolve);
      });
    }
    return Promise.resolve();
    // If no locks, proceed immediately
  }

  close(): Disposable {
    this.lockCount++;

    return {
      [Symbol.dispose]: () => {
        this.lockCount--;
        if (this.lockCount === 0) {
          // If no more locks, resolve any waiting open requests
          while (this.resolveQueue.length > 0) {
            const nextResolve = this.resolveQueue.shift();
            nextResolve!();
          }
        }
      },
    };
  }

  isGateLocked(): boolean {
    return this.lockCount > 0;
  }
}
