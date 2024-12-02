import { ActorCfRuntime, Env } from "@deco/actors/cf";
import { withActors } from "@deco/actors/hono";
import { Hono } from "hono";
import { Counter } from "./counter.ts";
export { ActorDurableObject } from "@deco/actors/cf";
const app = new Hono<{ Bindings: Env }>();

const runtime = new ActorCfRuntime([Counter]);
app.use(withActors(runtime));

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

export default app;
