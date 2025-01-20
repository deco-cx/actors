// src/durableObject.ts
import type {
  DurableObject,
  DurableObjectState,
} from "@cloudflare/workers-types";
import {
  type Actor,
  type ActorConstructor,
  ACTORS_API_SEGMENT,
  ACTORS_INVOKE_API_SEGMENT,
  StdActorRuntime,
  type WebSocketUpgradeHandler,
} from "../../runtime.ts";
import {
  type ActorMetadata,
  DurableObjectActorStorage,
} from "../../storage/cf.ts";
import { ACTOR_ID_QS_NAME } from "../../stubutil.ts";
import type { Env } from "./fetcher.ts";

let REGISTERED_ACTORS: ActorConstructor[] = [];
let WEBSOCKET_HANDLER: WebSocketUpgradeHandler | undefined;

/**
 * Register actors to be used by the Durable Object.
 */
export function registerActors(
  actors: ActorConstructor[],
  websocketHandler?: WebSocketUpgradeHandler,
) {
  REGISTERED_ACTORS = actors;
  WEBSOCKET_HANDLER = websocketHandler;
}

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
    this.runtime = new StdActorRuntime(actors ?? REGISTERED_ACTORS, env);
    if (WEBSOCKET_HANDLER) {
      this.runtime.setWebSocketHandler(WEBSOCKET_HANDLER);
    }
    this.alarms = {
      saveActorMetadata: async (options) => {
        await state.storage.set(ACTOR_METADATA_KEY, options);
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
export function WithRuntime<T extends Actor>(
  Actor: ActorConstructor<T>,
): DurableObject {
  return class DurableActor extends ActorDurableObject {
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
}
