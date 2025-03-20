// src/durableObject.ts
import type {
  DurableObject,
  DurableObjectState,
} from "@cloudflare/workers-types";
import type { ActorOptions } from "../../registry.ts";
import { Registry } from "../../registry.ts";
import {
  type Actor,
  type ActorConstructor,
  ACTORS_API_SEGMENT,
  ACTORS_INVOKE_API_SEGMENT,
  StdActorRuntime,
} from "../../runtime.ts";
import {
  type ActorMetadata,
  DurableObjectActorStorage,
} from "../../storage/cf.ts";
import { ACTOR_ID_QS_NAME, actors as _actors } from "../../stub/stub.ts";
import { createFetcher, type Env } from "./fetcher.ts";

export interface AlarmsManager {
  saveActorMetadata(options: ActorMetadata): Promise<void>;
  retrieveActorMetadata(): Promise<ActorMetadata>;
}

const ACTOR_METADATA_KEY = "__actor__metadata";
export class ActorDurableObject {
  protected runtime: StdActorRuntime;
  protected alarms: AlarmsManager;

  constructor(
    protected state: DurableObjectState,
    env: Env,
    actors?: ActorConstructor[],
  ) {
    this.runtime = new StdActorRuntime(
      env,
      actors ?? Registry.registered(),
      (c) => {
        return _actors.stub(c, {
          fetcher: createFetcher(env),
        });
      },
    );
    this.alarms = {
      saveActorMetadata: async (options) => {
        await state.storage.put(ACTOR_METADATA_KEY, options);
      },
      retrieveActorMetadata: async () => {
        return (await state.storage.get(ACTOR_METADATA_KEY));
      },
    };
    this.runtime.setDefaultActorStorage(
      (options) =>
        new DurableObjectActorStorage(state.storage, options, this.alarms),
    );
  }

  fetch(request: Request): Promise<Response> | Response {
    return this.runtime.fetch(request);
  }
}

/**
 * A Mixin to add the runtime to a Durable Object.
 */
export function CfActor<T extends Actor>(
  Actor: ActorConstructor<T>,
  options?: ActorOptions,
): new (state: DurableObjectState, env: Env) => DurableObject {
  Registry.register(options, Actor);
  const DurableActor = class extends ActorDurableObject {
    constructor(state: DurableObjectState, env: Env) {
      super(state, env, [Actor]);
    }
    async alarm(): Promise<void> {
      const metadata = await this.alarms.retrieveActorMetadata();
      if (!metadata) {
        console.error("no metadata found for actor");
        return;
      }
      const { actorId, actorName } = metadata;
      const url = new URL(
        `/${ACTORS_API_SEGMENT}/${actorName}/${ACTORS_INVOKE_API_SEGMENT}/alarm?${ACTOR_ID_QS_NAME}=${actorId}`,
        "http://localhost",
      );
      const response = await this.runtime.fetch(
        new Request(url, { method: "POST" }),
      );
      if (!response.ok) {
        throw new Error(
          `alarm error: ${await response.text()} ${response.status}`,
        );
      }
    }
  };
  Object.defineProperty(DurableActor, "name", { value: Actor.name });
  return DurableActor;
}
