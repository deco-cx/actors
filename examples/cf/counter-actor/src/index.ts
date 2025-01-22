import { ActorCfRuntime, Env, WithRuntime } from "@deco/actors/cf";
import { withActors } from "@deco/actors/hono";
import { Hono } from "hono";
import { Counter as MCounter } from "./counter.ts";
const app = new Hono<{ Bindings: Env }>();

const runtime = new ActorCfRuntime([MCounter]);
app.use(withActors(runtime));

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

export const Counter = WithRuntime(MCounter);
export default app;
