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
    if (!ctx.req.path.startsWith(basePath)) {
      return next();
    }
    const response = await rt.fetch(ctx.req.raw);
    ctx.res = response;
  };
};
