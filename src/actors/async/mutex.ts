export class Mutex implements Disposable {
  async [Symbol.dispose](): Promise<void> {
    await this.wait();
  }
  private _locked = false;
  private _waiters: (() => void)[] = [];

  lock(): Promise<Disposable> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve({ [Symbol.dispose]: () => this.unlock() });
    }

    return new Promise<Disposable>((resolve) => {
      this._waiters.push(() => {
        this._locked = true;
        resolve({ [Symbol.dispose]: () => this.unlock() });
      });
    });
  }

  private unlock(): void {
    this._locked = false;
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  wait(): Promise<void> {
    if (!this._locked) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }
}
