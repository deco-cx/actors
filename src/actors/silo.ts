import { ActorError } from "./errors.ts";
import { type ActorInvoker, create, createHttpInvoker } from "./proxyutil.ts";
import type { ActorConstructor, ActorInstance } from "./runtime.ts";
import { ActorState } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import { isUpgrade, makeDuplexChannel } from "./util/channels/channel.ts";
// deno-lint-ignore no-explicit-any
type FunctionType = (...args: any) => any;
const isInvocable = (f: unknown): f is FunctionType => {
  return typeof f === "function";
};

const KNOWN_METHODS: Record<string, symbol> = {
  "Symbol(Symbol.asyncDispose)": Symbol.asyncDispose,
  "Symbol(Symbol.dispose)": Symbol.dispose,
};

export class ActorSilo {
  private actors: Map<string, ActorInstance> = new Map<string, ActorInstance>();
  public invoker: ActorInvoker;

  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
    private actorId: string,
    private getActorStorage: (
      actorId: string,
      actorName: string,
    ) => ActorStorage,
  ) {
    this.invoker = {
      invoke: this.invoke.bind(this),
    };
    this.initializeActors();
  }

  private initializeActors() {
    this.actorsConstructors.forEach((Actor) => {
      const storage = this.getActorStorage(this.actorId, Actor.name);
      const state = new ActorState({
        id: this.actorId,
        storage,
        proxy: (actor) => {
          const invoker = (id: string) => {
            if (id === this.actorId) {
              return this.invoker;
            }
            return createHttpInvoker(id);
          };
          return create(actor, invoker);
        },
      });
      const actor = new Actor(state);
      this.actors.set(Actor.name, {
        actor,
        state,
        initialization: state.initialization,
      });
    });
  }

  private async invoke(
    actorName: string,
    methodName: string,
    args: unknown[],
    metadata: unknown,
    connect?: true,
  ) {
    const actorInstance = this.actors.get(actorName);
    if (!actorInstance) {
      throw new ActorError(`actor ${actorName} not found`, "NOT_FOUND");
    }

    await actorInstance.initialization;
    const method = KNOWN_METHODS[methodName] ?? methodName;
    if (!(method in actorInstance.actor)) {
      throw new ActorError(
        `method ${methodName} not found on actor ${actorName}`,
        "METHOD_NOT_FOUND",
      );
    }

    const methodImpl =
      actorInstance.actor[method as keyof typeof actorInstance.actor];

    if (!isInvocable(methodImpl)) {
      throw new ActorError(
        `method ${methodName} is not invocable on actor ${actorName}`,
        "METHOD_NOT_INVOCABLE",
      );
    }

    const actorProxy = new Proxy(actorInstance.actor, {
      get(target, prop, receiver) {
        if (prop === "metadata") {
          return metadata;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // deno-lint-ignore ban-types
    const result = await (methodImpl as Function).apply(
      actorProxy,
      Array.isArray(args) ? args : [args],
    );

    if (connect && isUpgrade(result)) {
      return makeDuplexChannel(result);
    }

    return result;
  }
}