// src/durableObject.ts
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  type ActorConstructor,
  ActorRuntime,
  type WebSocketUpgradeHandler,
} from "../../runtime.ts";
import { DurableObjectActorStorage } from "../../storage/cf.ts";
import { WELL_KNOWN_ALARM_METHOD } from "../../stubutil.ts";
import { invokePathname } from "../../util/id.ts";
import { ActorDOId, type Env } from "./fetcher.ts";

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

  constructor(
    public state: DurableObjectState,
    env: Env,
  ) {
    this.runtime = new ActorRuntime(REGISTERED_ACTORS, env);
    if (WEBSOCKET_HANDLER) {
      this.runtime.setWebSocketHandler(WEBSOCKET_HANDLER);
    }
    this.runtime.setDefaultActorStorage((options) =>
      new DurableObjectActorStorage(state.storage, options)
    );
  }

  async alarm() {
    const name = this.state.id.name ??
      this.state.storage.get<string>("DURABLE_OBJECT_NAME");

    if (!name) {
      console.error("could not determine actor name from id", this.state.id);
      return;
    }

    const locator = ActorDOId.unwind(name);
    const pathname = invokePathname({
      ...locator,
      method: WELL_KNOWN_ALARM_METHOD,
    });
    if (!pathname) {
      console.error("could not determine pathname from locator", locator);
      return;
    }

    await this.runtime.fetch(
      new Request(new URL(pathname, "http://localhost:8000"), {
        method: "POST",
      }),
    ); // fake url should work
  }

  fetch(request: Request): Promise<Response> | Response {
    return this.runtime.fetch(request);
  }
}
