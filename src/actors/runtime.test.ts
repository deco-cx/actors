import { assertEquals, assertFalse } from "@std/assert";
import { actors } from "./proxy.ts";
import { ActorRuntime } from "./runtime.ts";
import type { ActorState } from "./state.ts";
import type { ChannelUpgrader } from "./util/channels/channel.ts";
import { WatchTarget } from "./util/watch.ts";

class Hello {
  sayHello(): string {
    return "Hello, World!";
  }

  chan(name: string): ChannelUpgrader<string, string> {
    return (async ({ send }) => {
      for (let i = 0; i < 10; i++) {
        console.log("sending event", i);
        await send(`Hello ${name} ${i}`);
        console.log("event sent");
      }
    });
  }
}
class Counter {
  private count: number;
  private watchTarget = new WatchTarget<number>();

  constructor(protected state: ActorState) {
    this.count = 0;
    state.blockConcurrencyWhile(async () => {
      this.count = await this.state.storage.get<number>("counter") ?? 0;
    });
  }

  callSayHello(): Promise<string> {
    const hello = this.state.proxy(Hello).id(this.state.id);
    return hello.sayHello();
  }

  async increment(): Promise<number> {
    this.count++;
    await this.state.storage.put("counter", this.count);
    this.watchTarget.notify(this.count);
    return this.count;
  }

  async decrement(): Promise<number> {
    this.count--;
    await this.state.storage.put("counter", this.count);
    this.watchTarget.notify(this.count);
    return this.count;
  }

  getCount(): number {
    return this.count;
  }

  watch(): AsyncIterableIterator<number> {
    return this.watchTarget.subscribe();
  }
  async *readHelloChan(name: string): AsyncIterableIterator<string> {
    const hello = this.state.proxy(Hello).id(this.state.id);
    const helloChan = hello.chan(name);
    for await (const event of helloChan.recv()) {
      console.log("event received", event);
      yield event;
    }
  }

  chan(name: string): ChannelUpgrader<string, string> {
    return (async ({ send, recv }) => {
      await send(`Hello ${name}`);
      for await (const str of recv()) {
        if (str === "PING") {
          await send("PONG");
        }
      }
    });
  }
}

const runServer = (
  rt: ActorRuntime,
  onReq?: (req: Request) => void,
): AsyncDisposable => {
  const server = Deno.serve((req) => {
    onReq?.(req);
    return rt.fetch(req);
  });
  return {
    async [Symbol.asyncDispose]() {
      await server.shutdown();
    },
  };
};

Deno.test("counter tests", async () => {
  const rt = new ActorRuntime([Counter, Hello]);
  let reqCount = 0;
  await using _server = runServer(rt, () => {
    reqCount++;
  });
  const actorId = "1234";
  const counterProxy = actors.proxy(Counter);

  const actor = counterProxy.id(actorId);
  const name = `Counter Actor`;
  const ch = actor.chan(name);
  const it = ch.recv();
  const { value, done } = await it.next();

  assertFalse(done);
  assertEquals(value, `Hello ${name}`);

  await ch.send("PING");

  const { value: pong, done: pongDone } = await it.next();

  assertFalse(pongDone);
  assertEquals(pong, "PONG");

  await ch.close();

  const watcher = await actor.watch();

  assertEquals(await actor.getCount(), 0);

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

  const prevReqCount = reqCount;
  assertEquals(await actor.callSayHello(), "Hello, World!");
  assertEquals(reqCount, prevReqCount + 1); // does not need a new request for invoking another actor method

  const helloChan = await actor.readHelloChan(name);
  console.log(helloChan);
  for (let i = 0; i < 10; i++) {
    const { value } = await helloChan.next();
    assertEquals(`Hello ${name} ${i}`, value);
  }
});
