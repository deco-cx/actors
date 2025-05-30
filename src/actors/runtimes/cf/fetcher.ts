import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ActorBase } from "../../mod.ts";
import type { ActorOptions } from "../../registry.ts";
import { Registry } from "../../registry.ts";
import type { ActorConstructor, ActorRuntime } from "../../runtime.ts";
import {
  ACTOR_ID_HEADER_NAME,
  actors,
  type StubFetcher,
} from "../../stub/stub.ts";
import type { StubFactory } from "../../stub/stubutil.ts";
import { getActorLocator } from "../../util/locator.ts";
import { CfActor } from "./actorDO.ts";
import { WebSocketWrapper } from "./wsWrapper.ts";
export interface Env extends Record<string, DurableObjectNamespace> {
  ACTOR_DO?: DurableObjectNamespace;
}

/**
 * e.g. CountDown => COUNT_DOWN
 */
function toSnakeUpperCase(input: string) {
  return input
    .replace(/([a-z])([A-Z])/g, "$1_$2") // Insert underscore between lowercase and uppercase letters
    .replace(/[\s-]+/g, "_") // Replace spaces and hyphens with underscores
    .toUpperCase(); // Convert to uppercase
}

const getDO = (
  request: Request,
  env?: Env,
  ensurePublic: boolean = false,
): DurableObjectStub | undefined => {
  if (!env) {
    return undefined;
  }
  const actor = getActorLocator(request);

  if (!actor?.id) {
    return undefined;
  }
  const actorId = actor.id;

  if (ensurePublic && !Registry.isPublic(actor.name)) {
    return undefined;
  }

  const doName = toSnakeUpperCase(actor.name);
  const DO = doName in env ? env[doName] : env.ACTOR_DO;

  const id = DO.idFromName(actorId);
  return DO.get(id);
};

export const createFetcher = (env?: Env): StubFetcher => {
  return {
    createWebSocket: (urlOrString: string | URL) => {
      const url = new URL(urlOrString);
      const request = new Request(url);
      const durableObject = getDO(request, env);
      if (!durableObject) {
        throw new Error(`Missing ${ACTOR_ID_HEADER_NAME} or env`);
      }
      return new WebSocketWrapper(durableObject.connect(url.toString()));
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const durableObject = getDO(request, env);

      if (!durableObject) {
        return new Response(`Missing ${ACTOR_ID_HEADER_NAME} or env`, {
          status: 500,
        });
      }
      return await durableObject.fetch(request);
    },
  };
};
export class ActorCfRuntime<
  TEnvs extends object = object,
  TActors extends Array<ActorConstructor> = Array<ActorConstructor>,
> implements ActorRuntime<Env & TEnvs> {
  /**
   * Mark an actor as registered.
   */
  static Actor(
    options?: ActorOptions,
  ): <
    T extends ActorBase,
    TConstructor extends ActorConstructor<T>,
  >(
    Actor: TConstructor,
  ) => TConstructor {
    return <
      T extends ActorBase,
      TConstructor extends ActorConstructor<T>,
    >(
      Actor: TConstructor,
    ): TConstructor => {
      return CfActor(Actor, options) as TConstructor;
    };
  }

  constructor(protected actorsConstructors?: TActors) {
    if (this.actorsConstructors) {
      Registry.register({}, ...this.actorsConstructors);
    }
  }

  public stub<
    Constructor extends TActors[number] & ActorConstructor,
    TInstance extends InstanceType<Constructor>,
  >(c: Constructor | string, env: Env): StubFactory<TInstance> {
    return actors.stub<TInstance>(
      c as unknown as ActorConstructor<TInstance>,
      {
        fetcher: this.fetcher(env),
      },
    );
  }

  fetcher(env?: Env): StubFetcher {
    return createFetcher(env);
  }
  fetch(request: Request, env?: Env | undefined): Promise<Response> | Response {
    const durableObject = getDO(request, env, true); // ensure public
    if (!durableObject) {
      return new Response(`Missing ${ACTOR_ID_HEADER_NAME} or Env`, {
        status: 400,
      });
    }

    return durableObject.fetch(request);
  }
}
