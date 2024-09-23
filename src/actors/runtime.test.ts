import { assertEquals } from "@std/assert";
import { actors } from "./proxy.ts";
import { ActorRuntime } from "./runtime.ts";
import type { ActorState } from "./state.ts";

class Counter {
  private count: number;

  constructor(protected state: ActorState) {
    this.count = 0;
    state.blockConcurrencyWhile(async () => {
      this.count = await this.state.storage.get<number>("counter") ?? 0;
    });
  }

  async increment(): Promise<number> {
    await this.state.storage.put("counter", ++this.count);
    return this.count;
  }

  getCount(): number {
    return this.count;
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
  const counterProxy = actors.proxy({
    actor: Counter,
    server: "http://localhost:8000",
  });

  const actor = counterProxy.id(actorId);
  // Test increment
  const number = await actor.increment();
  assertEquals(number, 1);

  // Test getCount
  assertEquals(await actor.getCount(), 1);

  // Test increment again
  assertEquals(await actor.increment(), 2);

  // Test getCount again
  assertEquals(await actor.getCount(), 2);
});
