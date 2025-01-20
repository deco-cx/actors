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
import { DurableObjectActorStorage } from "../../storage/cf.ts";
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

export class ActorDurableObject {
  private runtime: StdActorRuntime;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    this.runtime = new StdActorRuntime(REGISTERED_ACTORS, env);
    if (WEBSOCKET_HANDLER) {
      this.runtime.setWebSocketHandler(WEBSOCKET_HANDLER);
    }
    this.runtime.setDefaultActorStorage(
      (options) => new DurableObjectActorStorage(state.storage, options),
    );
  }

  fetch(request: Request): Promise<Response> | Response {
    return this.runtime.fetch(request);
  }
}

export function WithRuntime<T extends Actor>(
  Actor: ActorConstructor<T>,
): DurableObject {
  return class DurableActor {
    private runtime: StdActorRuntime;

    constructor(protected state: DurableObjectState, protected env: Env) {
      this.runtime = new StdActorRuntime([Actor], env);
      if (WEBSOCKET_HANDLER) {
        this.runtime.setWebSocketHandler(WEBSOCKET_HANDLER);
      }
      this.runtime.setDefaultActorStorage(
        (options) => new DurableObjectActorStorage(state.storage, options),
      );
    }

    fetch(request: Request): Promise<Response> | Response {
      return this.runtime.fetch(request);
    }

    async alarm(): Promise<void> {
      const url = new URL(
        `/${ACTORS_API_SEGMENT}/${Actor.name}/${ACTORS_INVOKE_API_SEGMENT}/alarm?${ACTOR_ID_QS_NAME}=${this.state.id.name}`,
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
