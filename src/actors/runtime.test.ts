import { assertEquals } from "@std/assert";
import { actors } from "./proxy.ts";
import { ActorRuntime } from "./runtime.ts";
import type { ActorState } from "./state.ts";

class Counter {
  private count: number;
  private subscribers: Record<string, (count: number) => void> = {};

  constructor(protected state: ActorState) {
    this.count = 0;
    state.blockConcurrencyWhile(async () => {
      this.count = await this.state.storage.get<number>("counter") ?? 0;
    });
  }

  async increment(): Promise<number> {
    this.count++;
    await this.state.storage.put("counter", this.count);
    this.notifySubscribers();
    return this.count;
  }

  async decrement(): Promise<number> {
    this.count--;
    await this.state.storage.put("counter", this.count);
    this.notifySubscribers();
    return this.count;
  }

  getCount(): number {
    return this.count;
  }

  watch(): AsyncIterableIterator<number> {
    const subscription = crypto.randomUUID();
    const queue: Array<(value: IteratorResult<number>) => void> = [];

    const pushQueue = (value: IteratorResult<number>) => {
      queue.forEach((resolve) => resolve(value));
    };

    const nextPromise = () =>
      new Promise<IteratorResult<number>>((resolve) => {
        queue.push(resolve);
      });

    const iterator: AsyncIterableIterator<number> = {
      next: () => nextPromise(),
      return: () => {
        // Clean up the subscription when iterator.return() is called
        delete this.subscribers[subscription];
        // Return the "done" value for the iterator
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };

    this.subscribers[subscription] = (count: number) => {
      pushQueue({ value: count, done: false });
    };

    return iterator;
  }

  private notifySubscribers() {
    Object.values(this.subscribers).forEach((subscriber) =>
      subscriber(this.count)
    );
  }
}

const runServer = (rt: ActorRuntime): AsyncDisposable => {
  const server = Deno.serve(rt.fetch.bind(rt));
  return {
    async [Symbol.asyncDispose]() {
      await server.shutdown();
    },
  };
};

Deno.test("counter increment and getCount", async () => {
  const rt = new ActorRuntime([Counter]);
  await using _server = runServer(rt);
  const actorId = "1234";
  const counterProxy = actors.proxy(Counter);

  const actor = counterProxy.id(actorId);
  const watcher = await actor.watch();
  // Test increment
  const number = await actor.increment();
  assertEquals(number, 1);

  // Test getCount
  assertEquals(await actor.getCount(), 1);

  // Test increment again
  assertEquals(await actor.increment(), 2);

  // Test getCount again
  assertEquals(await actor.getCount(), 2);

  assertEquals(await actor.decrement(), 1);

  const counters = [1, 2, 1];
  let idx = 0;
  while (idx < counters.length) {
    const { value, done } = await watcher.next();
    assertEquals(value, counters[idx++]);
    assertEquals(done, false);
  }
  watcher.return?.();
});
