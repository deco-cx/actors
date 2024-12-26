// src/durableObject.ts
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  type ActorConstructor,
  ActorRuntime,
  type WebSocketUpgradeHandler,
} from "../../runtime.ts";
import { DurableObjectActorStorage } from "../../storage/cf.ts";
import { AlarmsManager } from "./alarms.ts";
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
  private runtime: ActorRuntime;
  private alarms: AlarmsManager;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    this.runtime = new ActorRuntime(REGISTERED_ACTORS, env);
    if (WEBSOCKET_HANDLER) {
      this.runtime.setWebSocketHandler(WEBSOCKET_HANDLER);
    }
    this.alarms = new AlarmsManager(state, this.runtime);
    this.runtime.setDefaultActorStorage(
      (options) =>
        new DurableObjectActorStorage(state.storage, options, this.alarms),
    );
  }

  alarm(): Promise<void> {
    return this.alarms.alarm();
  }

  fetch(request: Request): Promise<Response> | Response {
    return this.runtime.fetch(request);
  }
}
