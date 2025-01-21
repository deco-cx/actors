import type { Actor, ActorConstructor } from "./runtime.ts";

const REGISTERED_ACTORS: ActorConstructor[] = [];

/**
 * Mark an actor as registered.
 */
export function Actor<
  T extends Actor,
  TConstructor extends ActorConstructor<T>,
>(
  Actor: TConstructor,
): TConstructor {
  Registry.register(Actor);
  return Actor;
}

export const Registry = {
  registered: () => REGISTERED_ACTORS,
  register: (
    ...actors: ActorConstructor[]
  ) => {
    REGISTERED_ACTORS.push(...actors);
  },
};
