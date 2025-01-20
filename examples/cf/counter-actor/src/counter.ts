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

  alarm() {
    console.log("HELLO", this.state.id);
  }

  schedule() {
    this.state.storage.setAlarm(new Date().getTime() + 5000);
  }

  getCount(): number {
    return this.count + (this.metadata?.extraSum ?? 0);
  }

  watch(): AsyncIterableIterator<number> {
    return this.watchTarget.subscribe();
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
