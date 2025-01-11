import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ActorConstructor, ActorRuntime } from "../../runtime.ts";
import { type ActorFetcher, actors } from "../../stub.ts";
import { ACTOR_ID_HEADER_NAME, type StubFactory } from "../../stubutil.ts";
import { actorId as getActorId } from "../../util/id.ts";
import { registerActors } from "./actorDO.ts";
import { WebSocketWrapper } from "./wsWrapper.ts";

export interface Env {
  ACTOR_DO: DurableObjectNamespace;
}

export class ActorCfRuntime<
  TEnvs extends object = object,
  TActors extends Array<ActorConstructor> = Array<ActorConstructor>,
> implements ActorRuntime<Env & TEnvs> {
  constructor(protected actorsConstructors: TActors) {
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

  public stub<
    Constructor extends TActors[number] & ActorConstructor,
    TInstance extends InstanceType<Constructor>,
  >(c: Constructor | string, env: Env): { id: StubFactory<TInstance> } {
    return actors.stub<TInstance>(
      c as unknown as ActorConstructor<TInstance>,
      {
        fetcher: this.fetcher(env),
      },
    );
  }

  private getDO(request: Request, env?: Env): DurableObjectStub | undefined {
    if (!env) {
      return undefined;
    }
    const actorId = getActorId(request);

    if (!actorId) {
      return undefined;
    }

    const id = env.ACTOR_DO.idFromName(actorId);
    return env.ACTOR_DO.get(id);
  }
  fetcher(env?: Env): ActorFetcher {
    return {
      createWebSocket: (urlOrString: string | URL) => {
        const url = new URL(urlOrString);
        const request = new Request(url);
        const durableObject = this.getDO(request, env);
        if (!durableObject) {
          throw new Error(`Missing ${ACTOR_ID_HEADER_NAME} or env`);
        }
        return new WebSocketWrapper(durableObject.connect(url.toString()));
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const durableObject = this.getDO(request, env);

        if (!durableObject) {
          return new Response(`Missing ${ACTOR_ID_HEADER_NAME} or env`, {
            status: 500,
          });
        }
        return await durableObject.fetch(request);
      },
    };
  }
  fetch(request: Request, env?: Env | undefined): Promise<Response> | Response {
    const durableObject = this.getDO(request, env);
    if (!durableObject) {
      return new Response(`Missing ${ACTOR_ID_HEADER_NAME} or Env`, {
        status: 400,
      });
    }

    return durableObject.fetch(request);
  }
}
