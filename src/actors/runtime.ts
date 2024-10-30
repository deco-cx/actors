import process from "node:process";
import { ActorError } from "./errors.ts";
import {
  ACTOR_CONSTRUCTOR_NAME_HEADER,
  ACTOR_ID_HEADER_NAME,
  ACTOR_ID_QS_NAME,
  type ActorInvoker,
  create,
  createHttpInvoker,
} from "./proxyutil.ts";
import { ActorState } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import { DenoKvActorStorage } from "./storage/denoKv.ts";
import { S3ActorStorage } from "./storage/s3.ts";
import { EVENT_STREAM_RESPONSE_HEADER } from "./stream.ts";
import {
  isUpgrade,
  makeDuplexChannel,
  makeWebSocket,
} from "./util/channels/channel.ts";
import {
  type ServerSentEventMessage,
  ServerSentEventStream,
} from "./util/sse.ts";

/**
 * Represents an actor.
 */
// deno-lint-ignore no-empty-interface
export interface Actor {
}

const isEventStreamResponse = (
  invokeResponse: unknown | AsyncIterableIterator<unknown>,
): invokeResponse is AsyncIterableIterator<unknown> => {
  return (
    typeof (invokeResponse as AsyncIterableIterator<unknown>)?.next ===
      "function"
  );
};
/**
 * The name of the header used to specify the actor ID.
 */
const ACTORS_API_SEGMENT = "actors";
const ACTORS_INVOKE_API_SEGMENT = "invoke";

const parseActorInvokeApi = (pathname: string) => {
  if (!pathname) {
    return null;
  }
  const normalized = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const [_, actorsApiSegment, actorName, invokeApiSegment, methodName] =
    normalized
      .split("/");
  if (
    actorsApiSegment !== ACTORS_API_SEGMENT ||
    invokeApiSegment !== ACTORS_INVOKE_API_SEGMENT
  ) {
    return null;
  }
  return { actorName, methodName };
};

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
export interface ActorInstance {
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
  initialization: Promise<void>;
}

const KNOWN_METHODS: Record<string, symbol> = {
  "Symbol(Symbol.asyncDispose)": Symbol.asyncDispose,
  "Symbol(Symbol.dispose)": Symbol.dispose,
};
/**
 * Represents the runtime for managing and invoking actors.
 */
export class ActorRuntime {
  private actors: Map<string, ActorInstance> = new Map<string, ActorInstance>();
  private initilized = false;
  private invoker: ActorInvoker;
  /**
   * Creates an instance of ActorRuntime.
   * @param actorsConstructors - An array of actor constructors.
   */
  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
  ) {
    const invoke: ActorInvoker["invoke"] = async (
      actorName,
      methodName,
      args,
      metadata,
    ) => {
      const actorInvoker = actorName ? this.actors.get(actorName) : undefined;
      if (!actorInvoker) {
        throw new ActorError(`actor ${actorName} not found`, "NOT_FOUND");
      }
      const { actor, initialization } = actorInvoker;
      const method = KNOWN_METHODS[methodName] ?? methodName;
      if (!(method in actor)) {
        throw new ActorError(
          `actor ${actorName} not found`,
          "METHOD_NOT_FOUND",
        );
      }
      const methodImpl = actor[method as keyof typeof actor];
      if (!isInvocable(methodImpl)) {
        throw new ActorError(
          `actor ${actorName} not found`,
          "METHOD_NOT_INVOCABLE",
        );
      }
      await initialization;
      // Create a proxy to override the 'name' property for this specific bind
      const actorProxy = new Proxy(actor, {
        get(target, prop, receiver) {
          if (prop === "metadata") {
            return metadata; // Only modify this property for the proxy
          }
          return Reflect.get(target, prop, receiver); // Default behavior for other properties
        },
      });
      return await (methodImpl as Function).bind(actorProxy)(
        ...Array.isArray(args) ? args : [args],
      );
    };
    this.invoker = {
      invoke,
    };
  }

  getActorStorage(actorId: string, actorName: string): ActorStorage {
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
    });
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
      const storage = this.getActorStorage(actorId, Actor.name);
      const state = new ActorState({
        id: actorId,
        storage,
        proxy: (actor) => {
          const invoker = (id: string) => {
            if (id === actorId) {
              return {
                invoke: async (
                  name: string,
                  method: string,
                  args: unknown[],
                  metadata: unknown,
                  connect?: true,
                ) => {
                  const resp = await this.invoker.invoke(
                    name,
                    method,
                    args,
                    metadata,
                  );
                  if (connect && isUpgrade(resp)) {
                    return makeDuplexChannel(resp);
                  }
                  return resp;
                },
              };
            }
            return createHttpInvoker(id);
          };
          return create(actor, invoker);
        },
      });
      const actor = new Actor(
        state,
      );
      this.actors.set(Actor.name, {
        actor,
        state,
        initialization: state.initialization,
      });
    });
    this.initilized = true;
  }

  // some apis use handler (like deno.serve)
  handler(req: Request): Promise<Response> {
    return this.fetch(req);
  }

  /**
   * Handles an incoming request and invokes the corresponding actor method.
   * @param req - The incoming request.
   * @returns A promise that resolves to the response.
   */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const actorId = req.headers.get(ACTOR_ID_HEADER_NAME) ??
      url.searchParams.get(ACTOR_ID_QS_NAME);
    if (!actorId) {
      return new Response(`missing ${ACTOR_ID_HEADER_NAME} header`, {
        status: 400,
      });
    }

    this.ensureInitialized(actorId);

    const result = parseActorInvokeApi(url.pathname);
    if (!result) {
      return new Response(null, { status: 404 });
    }
    const actorName = result.actorName;
    const method = result.methodName;
    if (!method || !actorName) {
      return new Response(
        `method ${method} not found for the actor ${actorName}`,
        { status: 404 },
      );
    }
    let args = [], metadata = {};
    if (req.headers.get("content-type")?.includes("application/json")) {
      const { args: margs, metadata: maybeMetadata } = await req.json();
      args = margs;
      metadata = maybeMetadata;
    } else if (url.searchParams.get("args")) {
      const qargs = url.searchParams.get("args");

      const parsedArgs = qargs
        ? JSON.parse(atob(decodeURIComponent(qargs)))
        : {};
      args = parsedArgs.args;
      metadata = parsedArgs.metadata;
    }
    try {
      const res = await this.invoker.invoke(actorName, method, args, metadata);
      if (req.headers.get("upgrade") === "websocket" && isUpgrade(res)) {
        const { socket, response } = Deno?.upgradeWebSocket(req);
        makeWebSocket(socket).then((ch) => res(ch)).finally(() =>
          socket.close()
        );
        return response;
      }
      if (isEventStreamResponse(res)) {
        req.signal.onabort = () => {
          res?.return?.();
        };

        return new Response(
          new ReadableStream<ServerSentEventMessage>({
            async pull(controller) {
              for await (const content of res) {
                controller.enqueue({
                  data: encodeURIComponent(JSON.stringify(content)),
                  id: Date.now(),
                  event: "message",
                });
              }
              controller.close();
            },
            cancel() {
              res?.return?.();
            },
          }).pipeThrough(new ServerSentEventStream()),
          {
            headers: {
              "Content-Type": EVENT_STREAM_RESPONSE_HEADER,
            },
          },
        );
      }
      if (typeof res === "undefined" || res === null) {
        return new Response(null, { status: 204 });
      }
      if (res instanceof Uint8Array) {
        return new Response(res, {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": `${res.length}`,
          },
          status: 200,
        });
      }
      return Response.json(res);
    } catch (err) {
      if (err instanceof ActorError) {
        return new Response(err.message, {
          status: {
            METHOD_NOT_FOUND: 404,
            METHOD_NOT_INVOCABLE: 405,
            NOT_FOUND: 404,
          }[err.code] ?? 500,
        });
      }
      const constructorName = err?.constructor?.name;
      if (constructorName) {
        const serializedError = JSON.stringify(
          err,
          Object.getOwnPropertyNames(err),
        );
        return new Response(serializedError, {
          status: 500,
          headers: {
            [ACTOR_CONSTRUCTOR_NAME_HEADER]: constructorName,
            "content-type": "application/json",
          },
        });
      }
      throw err;
    }
  }
}
