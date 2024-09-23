import { assertEquals } from "@std/assert";
import { type Actor, ACTOR_ID_HEADER_NAME, ActorRuntime } from "./runtime.ts";
import type { ActorState } from "./state.ts";

interface ICounter {
  increment(): Promise<number>;
  getCount(): number;
}

export default class Counter implements ICounter, Actor {
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

const rt = new ActorRuntime([Counter]);
const req = new Request(
  "http://localhost:8000/actors/Counter/invoke/increment",
  {
    headers: {
      [ACTOR_ID_HEADER_NAME]: "1234",
    },
  },
);
const nullResp = await rt.fetch(req);
assertEquals(await nullResp.text(), "1");
const getReq = new Request(
  "http://localhost:8000/actors/Counter/invoke/getCount",
  {
    headers: {
      [ACTOR_ID_HEADER_NAME]: "1234",
    },
  },
);
const oneResp = await rt.fetch(getReq);
assertEquals(await oneResp.text(), "2");
