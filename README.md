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
import { Actor, actors, ActorState } from "@deco/actors";

@Actor() // optionally set { visibility: "private" } to not expose through API (currently handled only by cf workers)
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
const counter = actors.stub(Counter).id("counter-id");
// Increment counter
await counter.increment();
// Get current count
const currentCount = await counter.getCount();
console.log(`Current count: ${currentCount}`);
```

### Cloudflare Workers

The framework now supports Cloudflare Workers through Durable Objects, providing
the same actor model with CF's global distribution and reliability.

To deploy your actors on Cloudflare Workers:

1. Create your worker script (using Hono):

```typescript
import { Env } from "@deco/actors/cf";
import { withActors } from "@deco/actors/hono";
import { Hono } from "hono";
export { Counter } from "./counter.ts";

const app = new Hono<{ Bindings: Env }>();

app.use(withActors());

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

export default app;
```

2. Configure your `wrangler.toml`

```toml
#:schema node_modules/wrangler/config-schema.json
compatibility_flags = ["nodejs_compat"]
name = "counter-actor"
main = "src/index.ts"
compatibility_date = "2024-11-27"

# Workers Logs
# Docs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
# Configuration: https://developers.cloudflare.com/workers/observability/logs/workers-logs/#enable-workers-logs
[observability]
enabled = true

[[durable_objects.bindings]]
name = "ACTOR_DO"
class_name = "ActorDurableObject"

# Durable Object migrations.
# Docs: https://developers.cloudflare.com/workers/wrangler/configuration/#migrations
[[migrations]]
tag = "v1"
new_classes = ["ActorDurableObject"]
```

You check the full example [here](./examples/cf/)

If you want to work with alarms you need to create a durable object per actor,
in order to achieve that you need to import `CfActor` Mixin from cf package and
re-export as the name that you provide in the wrangler.toml

```tsx
import { Env } from "@deco/actors/cf";
import { withActors } from "@deco/actors/hono";
import { Hono } from "hono";
export { Counter } from "./counter.ts";
const app = new Hono<{ Bindings: Env }>();

app.use(withActors());

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

export default app;
```

```toml
[[durable_objects.bindings]]
name = "COUNTER"
class_name = "Counter"

# Durable Object migrations.
# Docs: https://developers.cloudflare.com/workers/wrangler/configuration/#migrations
[[migrations]]
tag = "v1"
new_classes = ["Counter"]
```


