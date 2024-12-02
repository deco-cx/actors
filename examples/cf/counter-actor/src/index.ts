import { ActorCfRuntime, Env } from "@deco/actors/cf";
import { withActors } from "@deco/actors/hono";
import { Hono } from "hono";
import { Counter } from "./counter.ts";
export { ActorDurableObject } from "@deco/actors/cf";
const app = new Hono<{ Bindings: Env }>();

const runtime = new ActorCfRuntime([Counter]);
const mid = withActors(runtime)
app.use(async (ctx, next) => {
  await mid(ctx, next);
  console.log(await ctx.res.text())
});

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

export default app;
