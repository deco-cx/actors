import { getRuntimeKey } from "@hono/hono/adapter";
import type { Actor as ActorBase } from "./mod.ts";
import type { ActorOptions } from "./registry.ts";
import {
  type ActorConstructor,
  type ActorRuntime,
  StdActorRuntime,
} from "./runtime.ts";

const IS_DENO = getRuntimeKey() === "deno";

export const RuntimeClass: {
  new (): ActorRuntime;
  Actor: (
    options?: ActorOptions,
  ) => <
    T extends ActorBase,
    TConstructor extends ActorConstructor<T>,
  >(
    Actor: TConstructor,
  ) => TConstructor;
} = IS_DENO ? StdActorRuntime : StdActorRuntime;

export const RUNTIME = new RuntimeClass();
export const Actor = RuntimeClass.Actor;
