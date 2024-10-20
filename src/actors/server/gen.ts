// generate a file actors.gen.ts based on the specified actors folder
// it contains the generated code for the actors in the folder
// and generates an entrypoint that runs Deno.serve with actor runtime without dynamic imports. useful for caching purposes and run.

import { dirname, join } from "@std/path";

if (import.meta.main) {
  const actorsFolder = Deno.args[0] ?? join(Deno.cwd(), "actors");
  const basedir = dirname(actorsFolder);

  const imports = [];
  for await (const dirEntry of Deno.readDir(actorsFolder)) {
    if (
      dirEntry.isFile && dirEntry.name.endsWith(".ts") ||
      dirEntry.name.endsWith(".tsx")
    ) {
      imports.push(
        `await import("${
          join(actorsFolder, dirEntry.name)
        }").then(mod => (mod as { default?: ActorConstructor })?.default)`,
      );
    }
  }
  await Deno.writeTextFile(
    join(basedir, "actors.gen.ts"),
    `
  // DO NOT EDIT THIS FILE IT WAS GENERATED BY ACTORS GEN
  import { type ActorConstructor, ActorRuntime } from "@deco/actors";
  const actors: ActorConstructor[] = [${
      imports.join(",")
    }].filter((actor) => actor?.name !== undefined);\n
  Deno.serve(new ActorRuntime(actors));\n`,
  );
}
