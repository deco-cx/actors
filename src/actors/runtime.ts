import { ActorState } from "./state.ts";
import { DenoKvActorStorage } from "./storage/denoKv.ts";
/**
 * Represents an actor.
 */
// deno-lint-ignore no-empty-interface
export interface Actor {
}

/**
 * The name of the header used to specify the actor ID.
 */
export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";
const ACTOR_NAME_PATH_PARAM = "actorName";
const METHOD_NAME_PATH_PARAM = "methodName";

/**
 * The URL pattern for invoking an actor method.
 */
export const actorInvokeUrl = new URLPattern({
  pathname:
    `/actors/:${ACTOR_NAME_PATH_PARAM}/invoke/:${METHOD_NAME_PATH_PARAM}`,
});

// deno-lint-ignore no-explicit-any
type Function = (...args: any) => any;
const isInvocable = (f: never | Function): f is Function => {
  return typeof f === "function";
};

/**
 * Represents a constructor function for creating an actor instance.
 * @template TInstance - The type of the actor instance.
 */
export type ActorConstructor<TInstance extends Actor = Actor> = new (
  state: ActorState,
) => TInstance;

/**
 * Represents an actor invoker.
 */
export interface ActorInvoker {
  /**
   * The actor instance.
   */
  actor: Actor;
  /**
   * The actor state.
   */
  state: ActorState;
  /**
   * A promise that resolves when the actor is initialized.
   */
  initialization: PromiseWithResolvers<void>;
}

/**
 * Represents the runtime for managing and invoking actors.
 */
export class ActorRuntime {
  private actors: Map<string, ActorInvoker> = new Map<string, ActorInvoker>();
  private initilized = false;
  /**
   * Creates an instance of ActorRuntime.
   * @param actorsConstructors - An array of actor constructors.
   */
  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
  ) {
  }

  /**
   * Ensures that the actors are initialized for the given actor ID.
   * @param actorId - The ID of the actor.
   */
  ensureInitialized(actorId: string) {
    if (this.initilized) {
      return;
    }
    this.actorsConstructors.forEach((Actor) => {
      const initialization = Promise.withResolvers<void>();
      const storage = new DenoKvActorStorage({
        actorId,
        actorName: Actor.name,
      });
      const state = new ActorState({
        initialization,
        storage,
      });
      const actor = new Actor(
        state,
      );
      this.actors.set(Actor.name, {
        actor,
        state,
        initialization,
      });
    });
    this.initilized = true;
  }

  /**
   * Handles an incoming request and invokes the corresponding actor method.
   * @param req - The incoming request.
   * @returns A promise that resolves to the response.
   */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const actorId = req.headers.get(ACTOR_ID_HEADER_NAME);
    if (!actorId) {
      return new Response(`missing ${ACTOR_ID_HEADER_NAME} header`, {
        status: 400,
      });
    }

    this.ensureInitialized(actorId);

    const result = actorInvokeUrl.exec(url);
    if (!result) {
      return new Response(null, { status: 404 });
    }
    const groups = result?.pathname.groups ?? {};
    const actorName = groups[ACTOR_NAME_PATH_PARAM];
    const actorInvoker = actorName ? this.actors.get(actorName) : undefined;
    if (!actorInvoker) {
      return new Response(`actor ${ACTOR_NAME_PATH_PARAM} not found`, {
        status: 404,
      });
    }
    const { actor, initialization } = actorInvoker;
    const method = groups[METHOD_NAME_PATH_PARAM];
    if (!method || !(method in actor)) {
      return new Response(`method not found for the actor`, { status: 404 });
    }
    let args = [];
    if (req.headers.get("content-length") !== null) {
      const { args: margs } = await req.json();
      args = margs;
    }
    const methodImpl = actor[method as keyof typeof actor];
    if (!isInvocable(methodImpl)) {
      return new Response(
        `cannot invoke actor method for type ${typeof methodImpl}`,
        {
          status: 400,
        },
      );
    }
    await initialization.promise;
    const res = await (methodImpl as Function).bind(actor)(
      ...Array.isArray(args) ? args : [args],
    );
    return Response.json(res);
  }
}
