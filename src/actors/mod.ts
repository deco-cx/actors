// deno-lint-ignore no-empty-interface
export interface Actor {
}

export type { ActorProxy } from "./proxyutil.ts";
export { ActorRuntime } from "./runtime.ts";
export type { ActorConstructor } from "./runtime.ts";
export { ActorState } from "./state.ts";
export { type ActorStorage } from "./storage.ts";
export { actorId } from "./util/id.ts";

