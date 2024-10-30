/**
 * This file serve as a set of utility for ease running actors in production.
 * It is not required for running actors in production. But it is useful for removing boilerplate code when you just want to spin up an actor server.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import * as fs from "node:fs/promises";
import process from "node:process";
import { type ActorConstructor, ActorRuntime } from "../runtime.ts";
if (import.meta.main) {
  const __dirname = dirname(fromFileUrl(import.meta.url)); // get the name of the directory
  const actorsFolder = process.argv[0] ?? join(__dirname, "actors");
  const actors: ActorConstructor[] = [];

  // dynamically import all actors in the actors folder.
  for (const dirEntry of await fs.readdir(actorsFolder)) {
    const stat = await fs.stat(dirEntry);
    if (
      stat.isFile() && dirEntry.endsWith(".ts") ||
      dirEntry.endsWith(".tsx")
    ) {
      const actor = await import(join(actorsFolder, dirEntry));
      if (actor.default) {
        actors.push(actor.default);
      }
    }
  }
  const runtime = new ActorRuntime(actors);

  typeof Deno !== "undefined" && Deno.serve(runtime);
}
