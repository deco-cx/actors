import { ActorState } from "@deco/actors";
import { ChannelUpgrader, WatchTarget } from "@deco/actors/watch";

export class Counter {
  private count: number;
  private watchTarget = new WatchTarget<number>();
  public metadata?: { extraSum: number };

  constructor(protected state: ActorState) {
    this.count = 0;
    state.blockConcurrencyWhile(async () => {
      this.count = await this.state.storage.get<number>("counter") ?? 0;
    });
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
  chan(name: string): ChannelUpgrader<string, string> {
    console.log("HERE");
    return (async ({ send, recv }) => {
      console.log("HERE1");
      await send(`Hello ${name}`);
      console.log("Sent Hello");
      for await (const str of recv()) {
        console.log({ str });
        if (str === "PING") {
          await send("PONG");
        }
      }
    });
  }
}
