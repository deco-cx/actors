import { assertEquals, assertFalse } from "jsr:@std/assert@^1.0.5";
import { Actor } from "./mod.ts";
import { StdActorRuntime } from "./runtime.ts";
import type { ActorState } from "./state.ts";
import { actors } from "./stub/stub.ts";
import type { ChannelUpgrader } from "./util/channels/channel.ts";
import { readAsBytes } from "./util/channels/chunked.ts";
import { WatchTarget } from "./util/watch.ts";

const HELLO_COUNT = 200;
@Actor()
class Hello {
  sayHello(): string {
    return "Hello, World!";
  }
  async uploadText(
    stream: ReadableStream<Uint8Array>,
    arg: string,
  ): Promise<string> {
    const bytes = await readAsBytes(stream);
    return new TextDecoder().decode(bytes) + arg;
  }

  chan(name: string): ChannelUpgrader<string, string> {
    return (async ({ send }) => {
      for (let i = 0; i < HELLO_COUNT; i++) {
        await send(`Hello ${name} ${i}`);
      }
    });
  }
}

@Actor()
class Counter {
  private count: number;
  private watchTarget = new WatchTarget<number>();
  public metadata?: { extraSum: number; signal?: AbortSignal };
  private listenerAttached = Promise.withResolvers<void>();

  constructor(protected state: ActorState) {
    this.count = 0;
    state.blockConcurrencyWhile(async () => {
      this.count = await this.state.storage.get<number>("counter") ?? 0;
    });
  }

  waitForAbortSignalAttach() {
    return this.listenerAttached.promise;
  }
  shouldFailWhenSignalIsAborted() {
    const p = Promise.withResolvers<string>();
    this.metadata?.signal?.addEventListener("abort", () => {
      p.resolve("HELLO ITS RESOLVED!");
    }, { once: true });
    this.listenerAttached.resolve();
    return p.promise;
  }
  callSayHello(): Promise<string> {
    const hello = this.state.stub(Hello).new(this.state.id);
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
    return this.count + (this.metadata?.extraSum ?? 0);
  }

  watch(): AsyncIterableIterator<number> {
    return this.watchTarget.subscribe();
  }

  async *readHelloChan(name: string): AsyncIterableIterator<string> {
    const hello = this.state.stub(Hello).new(this.state.id);
    using helloChan = hello.chan(name);
    for await (const event of helloChan.recv()) {
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
  rt: StdActorRuntime,
  onReq?: (req: Request) => void,
): AsyncDisposable => {
  const server = Deno.serve({
    port: 8002,
    handler: (req) => {
      onReq?.(req);
      return rt.fetch(req);
    },
  });
  return {
    async [Symbol.asyncDispose]() {
      await server.shutdown();
    },
  };
};

Deno.test("actor tests", async () => {
  const rt = new StdActorRuntime();
  let reqCount = 0;

  let nextRequest = Promise.withResolvers<() => void>();

  let abortRequestFn = nextRequest.promise;
  await using _server = runServer(rt, (rq) => {
    reqCount++;
    nextRequest.resolve(() => {
      rq.signal.dispatchEvent(new Event("abort"));
    });
    nextRequest = Promise.withResolvers<() => void>();
    abortRequestFn = nextRequest.promise;
  });
  const actorId = "1234";
  const counterStub = actors.stub(Counter, { maxWsChunkSize: 64 });

  const counterActor = counterStub.new(actorId);

  const waitForAttach = counterActor.waitForAbortSignalAttach().then((p) => p);
  await nextRequest.promise;
  const shouldReturnHelloOnlyWhenAborted = counterActor
    .shouldFailWhenSignalIsAborted().then(
      (p) => p,
    );
  const abort = await abortRequestFn;
  await waitForAttach;
  abort();
  assertEquals(await shouldReturnHelloOnlyWhenAborted, "HELLO ITS RESOLVED!");

  using rpcActor = counterStub.new("12345").rpc();

  const helloUploadActor = actors.stub(Hello).new("123456");

  // Test file upload
  const testData = new TextEncoder().encode("Hello ");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(testData);
      controller.close();
    },
  });

  const result = await helloUploadActor.uploadText(stream, "world");
  assertEquals(result, "Hello world");

  for (const actor of [rpcActor, counterActor]) {
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
    const p = performance.now();
    const watcher = await actor.watch();

    assertEquals(await actor.withMetadata({ extraSum: 10 }).getCount(), 10);

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
    const offset = actor === rpcActor ? 0 : 1; // rpc actor does not need a new request for invoking another actor method
    assertEquals(reqCount, prevReqCount + offset);

    const prevReqCountHello = reqCount;
    const helloChan = await actor.readHelloChan(name);
    for (let i = 0; i < HELLO_COUNT; i++) {
      const { value } = await helloChan.next();
      assertEquals(`Hello ${name} ${i}`, value);
    }
    helloChan.return?.();
    assertEquals(reqCount, prevReqCountHello + offset); // does not need a new request for invoking another actor method
    console.log(
      `${actor === rpcActor ? "[RPC]" : "[REQ-BASED]"}`,
      "actor took",
      performance.now() - p,
    );
  }
});
