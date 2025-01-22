import type { ActorConstructor } from "./runtime.ts";

const REGISTERED_ACTORS: Record<
  string,
  { options: ActorOptions; Ctor: ActorConstructor }
> = {};
export interface ActorOptions {
  visibility?: "private" | "public";
}
export const Registry = {
  registered: () => {
    return Object.values(REGISTERED_ACTORS).map(({ Ctor }) => Ctor);
  },
  isPublic: (Actor: ActorConstructor | string) => {
    const name = typeof Actor === "string" ? Actor : Actor.name;
    return name in
        REGISTERED_ACTORS &&
      REGISTERED_ACTORS[name].options.visibility === "public";
  },
  isRegistered: (Actor: ActorConstructor | string) =>
    (typeof Actor === "string" ? Actor : Actor.name) in REGISTERED_ACTORS,
  register: (
    options: ActorOptions = { visibility: "public" },
    ...actors: ActorConstructor[]
  ) => {
    options.visibility ??= "public";
    for (const Actor of actors) {
      REGISTERED_ACTORS[Actor.name] = { Ctor: Actor, options };
    }
  },
};
