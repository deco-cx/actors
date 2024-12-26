import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ActorConstructor, ActorFetcher } from "../../runtime.ts";
import { ACTOR_ID_HEADER_NAME } from "../../stubutil.ts";
import { type ActorLocator, locateActor } from "../../util/id.ts";
import { registerActors } from "./actorDO.ts";

export interface Env {
  ACTOR_DO: DurableObjectNamespace;
}
const SEPARATOR = "|#SEP#|";
export const ActorDOId = {
  build: (locator: ActorLocator) =>
    [locator.id, locator.name].filter((part) => part).join(
      SEPARATOR,
    ),
  unwind: (id: string): Omit<ActorLocator, "method"> => {
    const [id_, name] = id.split(SEPARATOR);
    return { id: id_, name };
  },
};

export class ActorCfRuntime<TEnvs extends object = object>
  implements ActorFetcher<Env & TEnvs> {
  constructor(protected actorsConstructors: Array<ActorConstructor>) {
    registerActors(actorsConstructors, () => {
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);
      const originalAccept = server.accept.bind(server);
      server.accept = () => {
        originalAccept();
        server.dispatchEvent(new Event("open"));
      };
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
    const locator: ActorLocator | { id: undefined } = locateActor(request) ??
      { id: undefined };

    if (!locator?.id) {
      return new Response(`Missing ${ACTOR_ID_HEADER_NAME}`, {
        status: 400,
      });
    }

    const id = env.ACTOR_DO.idFromName(ActorDOId.build(locator));
    const durableObject = env.ACTOR_DO.get(id);

    return durableObject.fetch(request);
  }
}
