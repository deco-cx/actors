import type { MiddlewareHandler } from "@hono/hono";
import type { ActorRuntime } from "../mod.ts";

/**
 * Adds middleware to the Hono server that routes requests to actors.
 * the default base path is `/actors`.
 */
export const useActors = (
  rt: ActorRuntime,
  basePath = "/actors",
): MiddlewareHandler => {
  return async (ctx, next) => {
    if (!ctx.req.path.startsWith(basePath)) {
      return next();
    }
    const response = await rt.fetch(ctx.req.raw);
    ctx.res = response;
  };
};
