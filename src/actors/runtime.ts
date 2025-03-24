import process from "node:process";
import { StubError } from "./errors.ts";
import type { ActorBase } from "./mod.ts";
import { type ActorOptions, Registry } from "./registry.ts";
import { ActorSilo } from "./silo.ts";
import type { ActorState, ActorStateOptions } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import { DenoKvActorStorage } from "./storage/denoKv.ts";
import { S3ActorStorage } from "./storage/s3.ts";
import { server } from "./stub/stub.server.ts";
import { ACTOR_ID_HEADER_NAME, type StubFetcher } from "./stub/stub.ts";
import { getActorLocator } from "./util/locator.ts";

/**
 * Represents a fetcher for actors.
 */
export interface ActorRuntime<TEnv extends object = object> {
  fetch: (request: Request, env?: TEnv) => Promise<Response> | Response;
  fetcher?: (env?: TEnv) => StubFetcher;
}

/**
 * Represents an actor.
 */
// deno-lint-ignore no-empty-interface
export interface Actor {}

export const ACTORS_API_SEGMENT = "actors";
export const ACTORS_INVOKE_API_SEGMENT = "invoke";

export type ActorConstructor<
  TInstance extends Actor = Actor,
  Env extends object = object,
> = new (
  state: ActorState,
  env?: Env,
) => TInstance;

export interface StubInstance {
  instance: Actor;
  state: ActorState;
  initialization: Promise<void>;
}

/**
 * Represents the runtime for managing and invoking actors.
 */
export class StdActorRuntime<TEnv extends object = object>
  implements ActorRuntime<TEnv> {
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
    return (
      Actor,
    ) => {
      Registry.register(options, Actor);
      return Actor;
    };
  }
  // Generally will be only one silo per runtime
  // but this makes it possible to have multiple silos for testing locally
  private silos: Map<string, ActorSilo> = new Map<string, ActorSilo>();
  private defaultActorStorage:
    | ((
      options: { actorId: string; actorName: string },
    ) => ActorStorage)
    | undefined;

  protected actorsConstructors: Array<ActorConstructor>;
  /**
   * WARNING: THIS FETCH DOES NOT SUPPORT ACTOR VISIBILITY MEANING THAT ALL ACTORS ARE EXPOSED BY DEFAULT AND THERE IS NO WAY TO MAKE THEM PRIVATE
   * Handles an incoming request and invokes the corresponding actor method.
   * @param req - The incoming request.
   * @returns A promise that resolves to the response.
   */
  public fetch: (req: Request) => Promise<Response>;
  /**
   * Creates an instance of ActorRuntime.
   * @param actorsConstructors - An array of actor constructors.
   */
  constructor(
    protected env?: TEnv,
    _actorsConstructors?: Array<ActorConstructor>,
    private stub?: ActorStateOptions["stub"],
  ) {
    this.actorsConstructors = _actorsConstructors ?? Registry.registered() ??
      [];

    this.fetch = server(this.instanceFactory.bind(this));
  }
  fetcher?: ((env?: TEnv | undefined) => StubFetcher) | undefined;

  setDefaultActorStorage(
    storageCreator: typeof this.defaultActorStorage,
  ) {
    this.defaultActorStorage = storageCreator;
  }
  getActorStorage(actorId: string, actorName: string): ActorStorage {
    if (this.defaultActorStorage) {
      return this.defaultActorStorage({ actorId, actorName });
    }
    const storage = process.env.DECO_ACTORS_STORAGE;

    if (storage === "s3") {
      return new S3ActorStorage({
        actorId,
        actorName,
      });
    }

    return new DenoKvActorStorage({
      actorId,
      actorName,
      runtime: this,
    });
  }
  private instanceFactory(name: string, req: Request): Promise<Actor> {
    const url = new URL(req.url);
    const locator = getActorLocator(url, req);
    if (!locator?.id) {
      throw new StubError(
        `missing ${ACTOR_ID_HEADER_NAME} header`,
        "NOT_FOUND",
      );
    }

    const silo = this.getOrCreateSilo(
      locator.id,
    );

    return silo.instance(name);
  }

  private getOrCreateSilo(actorId: string): ActorSilo {
    let silo = this.silos.get(
      actorId,
    );
    if (!silo) {
      silo = new ActorSilo(
        this.actorsConstructors,
        actorId,
        this.getActorStorage.bind(this),
        this.env,
        this.stub,
      );
      this.silos.set(actorId, silo);
    }
    return silo;
  }

  // Some APIs use handler (like Deno.serve)
  handler(req: Request): Promise<Response> {
    return this.fetch(req);
  }
}
