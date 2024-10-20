/**
 * This file serve as a set of utility for ease running actors in production.
 * It is not required for running actors in production. But it is useful for removing boilerplate code when you just want to spin up an actor server.
 */
import { join } from "@std/path";
import { type ActorConstructor, ActorRuntime } from "../runtime.ts";

if (import.meta.main) {
  const actorsFolder = Deno.args[0] ?? join(Deno.cwd(), "actors");
  const actors: ActorConstructor[] = [];

  // dynamically import all actors in the actors folder.
  for await (const dirEntry of Deno.readDir(actorsFolder)) {
    if (dirEntry.isFile && dirEntry.name.endsWith(".ts")) {
      const actor = await import(join(actorsFolder, dirEntry.name));
      if (actor.default) {
        actors.push(actor.default);
      }
    }
  }
  const runtime = new ActorRuntime(actors);

  Deno.serve(runtime);
}
