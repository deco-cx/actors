import type { Handler } from "@hono/hono";
import process from "node:process";
import { RUNTIME } from "../discover.ts";
import type { ActorRuntime } from "../runtime.ts";

/**
 * Adds middleware to the Hono server that routes requests to actors.
 * the default base path is `/actors`.
 */
export const withActors = <TEnv extends object = object>(
  fetcher: ActorRuntime<TEnv> = RUNTIME,
  basePath = "/actors",
): Handler<{ Bindings: TEnv }> => {
  return async (ctx, next) => {
    const path = ctx.req.path;
    if (!path.startsWith(basePath)) {
      return next();
    }
    if (path.endsWith(`${basePath}/__restart`)) {
      console.log("Restarting actors...");
      process.exit(1);
    }
    return ctx.res = await fetcher.fetch(ctx.req.raw, ctx.env);
  };
};
