import { Mutex } from "./async/mutex.ts";
import { ActorState } from "./state.ts";
import { DenoKvActorStorage } from "./storage/denoKv.ts";

// deno-lint-ignore no-empty-interface
export interface Actor {
}

export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";
const ACTOR_NAME_PATH_PARAM = "actorName";
const METHOD_NAME_PATH_PARAM = "methodName";
const actorInvokeUrl = new URLPattern({
  pathname:
    `/actors/:${ACTOR_NAME_PATH_PARAM}/invoke/:${METHOD_NAME_PATH_PARAM}`,
});

// deno-lint-ignore no-explicit-any
type Function = (...args: any) => any;
const isInvocable = (f: never | Function): f is Function => {
  return typeof f === "function";
};

export interface ActorInvoker {
  actor: Actor;
  reqMu: Mutex;
  respMu: Mutex;
}

export class ActorRuntime {
  private actors: Map<string, ActorInvoker> = new Map<string, ActorInvoker>();
  private initilized = false;
  constructor(
    protected actorsConstructors: Array<new (state: ActorState) => Actor>,
  ) {
  }
  ensureInitialized(actorId: string) {
    if (this.initilized) {
      return;
    }
    this.actorsConstructors.forEach((Actor) => {
      const reqMu = new Mutex();
      const respMu = new Mutex();
      // TODO how to commit uncommited changes?
      const storage = new DenoKvActorStorage({
        actorId,
        actorName: Actor.name,
      });
      const actor = new Actor(
        new ActorState({
          reqMu,
          respMu,
          storage,
        }),
      );
      this.actors.set(Actor.name, {
        actor,
        reqMu,
        respMu,
      });
    });
    this.initilized = true;
  }
  async fetch(req: Request) {
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
    const { actor, reqMu, respMu } = actorInvoker;
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
    console.log("waiting");
    await reqMu.wait();
    console.log("finished");
    const res = await (methodImpl as Function).bind(actor)(
      ...Array.isArray(args) ? args : [args],
    );
    await respMu.wait();
    return Response.json(res);
  }
}
