import { ActorError } from "./errors.ts";
import { rpc } from "./rpc.ts";
import type { ActorConstructor, ActorInstance } from "./runtime.ts";
import { ActorState } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import {
  type ActorInvoker,
  create,
  createHttpInvoker,
  type EnrichMetadataFn,
  WELL_KNOWN_RPC_MEHTOD,
} from "./stubutil.ts";
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

const WELL_KNOWN_ENRICH_METADATA_METHOD = "enrichMetadata";
const isWellKnownRPCMethod = (methodName: string) =>
  methodName === WELL_KNOWN_RPC_MEHTOD;

export class ActorSilo<TEnv extends object = object> {
  private actors: Map<string, ActorInstance> = new Map<string, ActorInstance>();
  public invoker: ActorInvoker;

  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
    private actorId: string,
    private getActorStorage: (
      actorId: string,
      actorName: string,
    ) => ActorStorage,
    private env?: TEnv,
  ) {
    this.invoker = {
      invoke: this.invoke.bind(this),
    };
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
              return this.invoker;
            }
            return createHttpInvoker(id, options);
          };
          return create(actor, invoker);
        },
      });
      const actor = new Actor(state, this.env);
      this.actors.set(Actor.name, {
        actor,
        state,
        initialization: state.initialization,
      });
    });
  }

  public async invoke(
    actorName: string,
    methodName: string,
    args: unknown[],
    metadata: unknown,
    connect?: boolean,
    req?: Request,
  ) {
    const actorInstance = this.actors.get(actorName);
    if (!actorInstance) {
      throw new ActorError(`actor ${actorName} not found`, "NOT_FOUND");
    }

    await actorInstance.initialization;
    actorInstance.actor;
    const method = KNOWN_METHODS[methodName] ?? methodName;
    metadata = WELL_KNOWN_ENRICH_METADATA_METHOD in actorInstance.actor && req
      ? await (actorInstance.actor.enrichMetadata as EnrichMetadataFn<unknown>)(
        metadata,
        req,
      )
      : metadata;
    if (isWellKnownRPCMethod(String(method))) {
      const chan = rpc(this.invoker, metadata);
      return chan;
    }
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

    const actorStub = new Proxy(actorInstance.actor, {
      get(target, prop, receiver) {
        if (prop === "metadata") {
          return metadata;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // deno-lint-ignore ban-types
    const result = await (methodImpl as Function).apply(
      actorStub,
      Array.isArray(args) ? args : [args],
    );

    if (connect && isUpgrade(result)) {
      return makeDuplexChannel(result);
    }

    return result;
  }
}
