import { StubError } from "./errors.ts";
import { invoke } from "./stub/invoker.ts";
import type { ActorConstructor, StubInstance } from "./runtime.ts";
import { ActorState, type ActorStateOptions } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import { createActorHttpInvoker } from "./stub/stub.ts";
import { create } from "./stub/stubutil.ts";

export class ActorSilo<TEnv extends object = object> {
  private actors: Map<string, StubInstance> = new Map<string, StubInstance>();
  private actorConstructors: Map<string, ActorConstructor> = new Map<
    string,
    ActorConstructor
  >();

  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
    private actorId: string,
    private getActorStorage: (
      actorId: string,
      actorName: string,
    ) => ActorStorage,
    private env?: TEnv,
    private stub?: ActorStateOptions["stub"],
  ) {
    this.actorsConstructors.forEach((Actor) => {
      this.actorConstructors.set(Actor.name, Actor);
    });
  }

  private initializeActor(actorName: string) {
    const Actor = this.actorConstructors.get(actorName);
    if (!Actor) {
      throw new StubError(`actor ${actorName} not found`, "NOT_FOUND");
    }
    const storage = this.getActorStorage(this.actorId, actorName);
    const state = new ActorState({
      id: this.actorId,
      storage,
      stub: this.stub ?? ((actor, options) => {
        const invoker = (id: string) => {
          if (id === this.actorId) {
            return {
              invoke: this.invoke.bind(this),
            };
          }
          return createActorHttpInvoker(id, options);
        };
        return create(actor, invoker);
      }),
    });
    const actor = new Actor(state, this.env);
    this.actors.set(Actor.name, {
      instance: actor,
      state,
      initialization: state.initialization,
    });
  }

  public async instance(actorName: string) {
    let actorInstance = this.actors.get(actorName);
    if (!actorInstance) {
      this.initializeActor(actorName);
      actorInstance = this.actors.get(actorName);
    }
    if (!actorInstance) {
      throw new StubError(`actor ${actorName} not found`, "NOT_FOUND");
    }
    await actorInstance.initialization;
    return actorInstance.instance;
  }

  public async invoke(
    actorName: string,
    methodName: string,
    args: unknown[],
    metadata: unknown,
    connect?: true,
    req?: Request,
  ) {
    return invoke({
      instance: await this.instance(actorName),
      stubName: actorName,
      methodName,
      args,
      metadata,
      connect,
      request: req,
    });
  }
}
