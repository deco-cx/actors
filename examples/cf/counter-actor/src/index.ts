import { Hono } from "hono";
export { ActorDurableObject } from "@deco/actors/cf";
const app = new Hono();

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));

export default app;
