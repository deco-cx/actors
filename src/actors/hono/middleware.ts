import type { MiddlewareHandler } from "@hono/hono";
import { ActorRuntime } from "../mod.ts";
import type { ActorConstructor } from "../runtime.ts";

/**
 * Adds middleware to the Hono server that routes requests to actors.
 * the default base path is `/actors`.
 */
export const withActors = (
  rtOrActors: ActorRuntime | Array<ActorConstructor>,
  basePath = "/actors",
): MiddlewareHandler => {
  const rt = Array.isArray(rtOrActors)
    ? new ActorRuntime(rtOrActors)
    : rtOrActors;
  return async (ctx, next) => {
    const path = ctx.req.path;
    if (!path.startsWith(basePath)) {
      return next();
    }
    if (path.endsWith(`${basePath}/__restart`)) {
      console.log("Restarting actors...");
      Deno.exit(1);
    }
    const response = await rt.fetch(ctx.req.raw);
    ctx.res = response;
  };
};
