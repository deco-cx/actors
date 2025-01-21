// deno-lint-ignore no-empty-interface
export interface Actor {
}
export type { Actor as ActorBase };

// Backwards compatibility for the old name
export { StdActorRuntime as ActorRuntime } from "./runtime.ts";

export { StdActorRuntime } from "./runtime.ts";
export type { ActorConstructor } from "./runtime.ts";
export { ActorState } from "./state.ts";
export { type ActorStorage } from "./storage.ts";
export type {
  ActorProxy,
  ActorProxy as ActorStub,
  StubFactory,
  StubFactoryFn,
} from "./stubutil.ts";
export { getActorLocator } from "./util/locator.ts";

export { Actor, RuntimeClass } from "./discover.ts";
