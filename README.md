<a href="https://jsr.io/@deco/actors" target="_blank"><img alt="jsr" src="https://jsr.io/badges/@deco/actors" /></a>

# Actors

High-scale interactive services often demand a combination of high throughput,
low latency, and high availability. These are challenging goals to meet with
traditional stateless architectures. Inspired by the Orleans virtual-actor
pattern, the **Actors** library offers a stateful solution, enabling developers
to manage distributed state in a seamless and scalable way.

The **Actors** model simplifies the development of stateful applications by
abstracting away the complexity of distributed system concerns, such as
reliability and resource management. This allows developers to focus on building
logic while the framework handles the intricacies of state distribution and
fault tolerance.

With **Actors**, developers create "actors" – isolated, stateful objects that
can be invoked directly. Each actor is uniquely addressable, enabling efficient
and straightforward interaction across distributed environments.

## Key Features

- **Simplified State Management:** Build stateful services using a
  straightforward programming model, without worrying about distributed systems
  complexities like locks or consistency.
- **No Distributed Locks:** Actors handle state independently, eliminating the
  need for distributed locks. Each actor is responsible for its own state,
  making it simple to work with highly concurrent scenarios without race
  conditions.
- **Virtual Actors:** Actors are automatically instantiated, managed, and scaled
  by the framework, freeing you from managing lifecycles manually.
- **Powered by Deno Cluster Isolates:** Achieve high-performance applications
  that scale effortlessly by leveraging Deno cluster's unique isolate
  addressing.

## Example: Simple Atomic Counter without Distributed Locks

```typescript
import { actors, ActorState } from "@deco/actors";

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

// Invoking the counter actor
const counterProxy = actors.proxy({
  actor: Counter,
  server: "http://localhost:8000",
});
const counter = counterProxy.id("counter-id");
// Increment counter
await counter.increment();
// Get current count
const currentCount = await counter.getCount();
console.log(`Current count: ${currentCount}`);
```
