import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { ACTOR_ID_HEADER_NAME } from "../../proxyutil.ts";
import type { ActorConstructor, ActorFetcher } from "../../runtime.ts";
import { actorId as getActorId } from "../../util/id.ts";
import { registerActors } from "./actorDO.ts";

export interface Env {
  ACTOR_DO: DurableObjectNamespace;
}

export class ActorCfRuntime implements ActorFetcher<Env> {
  constructor(protected actorsConstructors: Array<ActorConstructor>) {
    registerActors(actorsConstructors, () => {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      server.accept();
      return {
        socket: server,
        response: new Response(null, {
          status: 101,
          // @ts-ignore: webSocket is not part of the Response type
          webSocket: client,
        }),
      };
    });
  }
  fetch(request: Request, env?: Env | undefined): Promise<Response> | Response {
    if (!env) {
      return new Response("Missing env", { status: 500 });
    }
    const actorId = getActorId(request);

    if (!actorId) {
      return new Response(`Missing ${ACTOR_ID_HEADER_NAME}`, {
        status: 400,
      });
    }

    const id = env.ACTOR_DO.idFromName(actorId);
    const durableObject = env.ACTOR_DO.get(id);

    return durableObject.fetch(request);
  }
}
