import { Env } from "@deco/actors/cf";
import { withActors } from "@deco/actors/hono";
import { Hono } from "hono";
export { Counter } from "./counter.ts";

const app = new Hono<{ Bindings: Env }>();

app.use(withActors());

app.get("/", (c) => c.text("Hello Cloudflare Workers!"));
export default app;
