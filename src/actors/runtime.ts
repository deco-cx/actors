// deno-lint-ignore-file no-explicit-any
import process from "node:process";
import { ActorError } from "./errors.ts";
import { ActorSilo } from "./silo.ts";
import type { ActorState } from "./state.ts";
import type { ActorStorage } from "./storage.ts";
import { DenoKvActorStorage } from "./storage/denoKv.ts";
import { S3ActorStorage } from "./storage/s3.ts";
import {
  EVENT_STREAM_RESPONSE_HEADER,
  isEventStreamResponse,
} from "./stream.ts";
import type { ActorFetcher } from "./stub.ts";
import {
  ACTOR_CONSTRUCTOR_NAME_HEADER,
  ACTOR_ID_HEADER_NAME,
  ACTOR_MAX_CHUNK_SIZE_QS_NAME,
} from "./stubutil.ts";
import { serializeUint8Array } from "./util/buffers.ts";
import { isUpgrade, makeWebSocket } from "./util/channels/channel.ts";
import { getActorLocator } from "./util/locator.ts";
import {
  type ServerSentEventMessage,
  ServerSentEventStream,
} from "./util/sse.ts";

/**
 * Represents a fetcher for actors.
 */
export interface ActorRuntime<TEnv extends object = object> {
  fetch: (request: Request, env?: TEnv) => Promise<Response> | Response;
  fetcher?: (env?: TEnv) => ActorFetcher;
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

export interface ActorInstance {
  actor: Actor;
  state: ActorState;
  initialization: Promise<void>;
}

export interface WebSocketUpgrade {
  socket: WebSocket;
  response: Response;
}

const useCorsCredentials = (
  allowedOrigins: string[],
  reqHeaders: Headers,
  respHeaders: Headers,
) => {
  const origin = reqHeaders.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) {
    return;
  }
  respHeaders.set(
    "Access-Control-Allow-Origin",
    origin,
  );
  respHeaders.set("Access-Control-Allow-Methods", "*");
  // according to MDN https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers
  // requests with credentials require a specific list of headers instead of *

  const reqHeadersList: string[] = [];
  reqHeaders.forEach((_, key) => {
    reqHeadersList.push(key);
  });

  respHeaders.set(
    "Access-Control-Allow-Headers",
    reqHeadersList.join(","),
  );
  respHeaders.set("Access-Control-Allow-Credentials", "true");
};

export type WebSocketUpgradeHandler = (
  req: Request,
) => WebSocketUpgrade | Promise<WebSocketUpgrade>;
export interface Env extends Record<string, string> {}
/**
 * Represents the runtime for managing and invoking actors.
 */
export class StdActorRuntime<TEnv extends Env = Env>
  implements ActorRuntime<TEnv> {
  // Generally will be only one silo per runtime
  // but this makes it possible to have multiple silos for testing locally
  private silos: Map<string, ActorSilo> = new Map<string, ActorSilo>();
  private defaultActorStorage:
    | ((
      options: { actorId: string; actorName: string },
    ) => ActorStorage)
    | undefined;

  private websocketHandler?: WebSocketUpgradeHandler;
  /**
   * Creates an instance of ActorRuntime.
   * @param actorsConstructors - An array of actor constructors.
   */
  constructor(
    protected actorsConstructors: Array<ActorConstructor>,
    protected env?: TEnv,
  ) {
    this.websocketHandler = typeof Deno === "object"
      ? Deno?.upgradeWebSocket
      : undefined;
  }

  setWebSocketHandler(
    handler: WebSocketUpgradeHandler,
  ) {
    this.websocketHandler = handler;
  }

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
    });
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
      );
      this.silos.set(actorId, silo);
    }
    return silo;
  }

  // Some APIs use handler (like Deno.serve)
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
    const locator = getActorLocator(url, req);

    if (!locator) {
      return new Response(null, { status: 404 });
    }

    if (!locator?.id) {
      return new Response(`missing ${ACTOR_ID_HEADER_NAME} header`, {
        status: 400,
      });
    }

    const silo = this.getOrCreateSilo(
      locator.id,
    );

    const { name: actorName, method: methodName } = locator;
    if (!methodName || !actorName) {
      return new Response(
        `method ${methodName} not found for the actor ${actorName}`,
        { status: 404 },
      );
    }
    let args = [], metadata = {};
    if (req.headers.get("content-type")?.includes("application/json")) {
      const { args: margs, metadata: maybeMetadata } = (await req
        .json()) as any;
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
      const res = await silo.invoker.invoke(
        actorName,
        methodName,
        args,
        metadata,
      );
      if (req.headers.get("upgrade") === "websocket" && isUpgrade(res)) {
        if (!this.websocketHandler) {
          return new Response("WebSockets are not supported", { status: 400 });
        }
        const { socket, response } = await this.websocketHandler(req);
        const chunkSize = url.searchParams.get(ACTOR_MAX_CHUNK_SIZE_QS_NAME);
        makeWebSocket(
          socket,
          typeof chunkSize === "string" ? +chunkSize : undefined,
        ).then((ch) => res(ch)).finally(() => socket.close());
        return response;
      }
      if (isEventStreamResponse(res)) {
        req.signal.onabort = () => {
          res?.return?.();
        };

        const sseHeaders = new Headers({
          "Content-Type": EVENT_STREAM_RESPONSE_HEADER,
        });
        // due to a cloudflare bug which text/event-stream headers are immutable and cors canno't be set.
        if (this.env?.USE_SSE_CORS_ORIGIN) {
          useCorsCredentials(
            this.env.USE_SSE_CORS_ORIGIN.split(","),
            req.headers,
            sseHeaders,
          );
        }
        return new Response(
          new ReadableStream<ServerSentEventMessage>({
            async pull(controller) {
              for await (const content of res) {
                controller.enqueue({
                  data: encodeURIComponent(
                    JSON.stringify(content, serializeUint8Array),
                  ),
                  id: Date.now().toString(),
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
            headers: sseHeaders,
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
          status: 400,
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
