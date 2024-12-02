import type { MiddlewareHandler } from "@hono/hono";
import process from "node:process";
import type { ActorFetcher } from "../runtime.ts";

/**
 * Adds middleware to the Hono server that routes requests to actors.
 * the default base path is `/actors`.
 */
export const withActors = (
  fetcher: ActorFetcher,
  basePath = "/actors",
): MiddlewareHandler => {
  return async (ctx, next) => {
    const path = ctx.req.path;
    if (!path.startsWith(basePath)) {
      return next();
    }
    if (path.endsWith(`${basePath}/__restart`)) {
      console.log("Restarting actors...");
      process.exit(1);
    }
    const response = await fetcher.fetch(ctx.req.raw, ctx.env);
    ctx.res = response;
  };
};
