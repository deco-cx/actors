import { StubError } from "./errors.ts";
import { invoke } from "./stub/invoker.ts";
import type { ActorConstructor, StubInstance } from "./runtime.ts";
import { ActorState } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import { createActorHttpInvoker } from "./stub/stub.ts";
import { create } from "./stub/stubutil.ts";

export class ActorSilo<TEnv extends object = object> {
  private actors: Map<string, StubInstance> = new Map<string, StubInstance>();

  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
    private actorId: string,
    private getActorStorage: (
      actorId: string,
      actorName: string,
    ) => ActorStorage,
    private env?: TEnv,
  ) {
    this.initializeActors();
  }

  private initializeActors() {
    this.actorsConstructors.forEach((Actor) => {
      if (this.actors.has(Actor.name)) {
        return;
      }
      const storage = this.getActorStorage(this.actorId, Actor.name);
      const state = new ActorState({
        id: this.actorId,
        storage,
        stub: (actor, options) => {
          const invoker = (id: string) => {
            if (id === this.actorId) {
              return {
                invoke: this.invoke.bind(this),
              };
            }
            return createActorHttpInvoker(id, options);
          };
          return create(actor, invoker);
        },
      });
      const actor = new Actor(state, this.env);
      this.actors.set(Actor.name, {
        instance: actor,
        state,
        initialization: state.initialization,
      });
    });
  }
  public async instance(actorName: string) {
    const actorInstance = this.actors.get(actorName);
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
    const actorInstance = this.actors.get(actorName);
    if (!actorInstance) {
      throw new StubError(`actor ${name} not found`, "NOT_FOUND");
    }
    await actorInstance.initialization;
    const instance = actorInstance.instance;
    return invoke(
      instance,
      actorName,
      methodName,
      args,
      metadata,
      connect,
      req,
    );
  }
}
