// deno-lint-ignore-file no-explicit-any
import { getRuntimeKey } from "@hono/hono/adapter";
import { StubError } from "../errors.ts";
import {
  EVENT_STREAM_RESPONSE_HEADER,
  isEventStreamResponse,
} from "../stream.ts";
import { serializeUint8Array } from "../util/buffers.ts";
import { isUpgrade, makeWebSocket } from "../util/channels/channel.ts";
import { invokeNameAndMethod } from "../util/locator.ts";
import {
  type ServerSentEventMessage,
  ServerSentEventStream,
} from "../util/sse.ts";
import { invoke, type InvokeOptions } from "./invoker.ts";
import {
  STUB_CONSTRUCTOR_NAME_HEADER,
  STUB_MAX_CHUNK_SIZE_QS_NAME,
} from "./stubutil.ts";

function isFormData(request: Request) {
  const contentType = request.headers.get("Content-Type") || "";
  return contentType.includes("multipart/form-data");
}

const upgradeWebSocket = (req: Request) => {
  if (getRuntimeKey() === "deno") {
    return Deno.upgradeWebSocket(req);
  }
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);
  const originalAccept = server.accept.bind(server);
  server.accept = () => {
    originalAccept();
    server.dispatchEvent(new Event("open"));
  };
  return {
    socket: server,
    response: new Response(null, {
      status: 101,
      // @ts-ignore: webSocket is not part of the Response type
      webSocket: client,
    }),
  };
};

export interface InvokeMiddlewareOptions {
  method: string;
  args: unknown[];
  metadata: unknown;
  request: Request;
}

export type InvokeMiddleware = (
  options: InvokeMiddlewareOptions,
  next: (options: InvokeMiddlewareOptions) => Promise<Response>,
) => Promise<Response>;

const hasInvokeMiddleware = (
  instance: unknown,
): instance is { onBeforeInvoke: InvokeMiddleware } => {
  return typeof instance === "object" && instance != null &&
    "onBeforeInvoke" in instance &&
    typeof instance.onBeforeInvoke === "function";
};

const invokeResponse = async (
  url: URL,
  options: InvokeOptions<any> & { request: Request },
): Promise<Response> => {
  try {
    const { request: req } = options;
    const res = await invoke(options);
    if (isUpgrade(res) && req.headers.get("upgrade") === "websocket") {
      const { socket, response } = upgradeWebSocket(req);
      const chunkSize = url.searchParams.get(STUB_MAX_CHUNK_SIZE_QS_NAME);
      makeWebSocket(
        socket,
        typeof chunkSize === "string" ? +chunkSize : undefined,
      ).then((ch) => res(ch)).catch((err) => {
        console.error(`socket error`, err);
      }).finally(() => socket.close());
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
          headers: {
            "Content-Type": EVENT_STREAM_RESPONSE_HEADER,
          },
        },
      );
    }
    if (res instanceof ReadableStream) {
      return new Response(res, {
        headers: {
          "content-type": "application/octet-stream",
        },
      });
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
    if (res instanceof Response) {
      return res;
    }
    return Response.json(res);
  } catch (err) {
    if (err instanceof StubError) {
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
          [STUB_CONSTRUCTOR_NAME_HEADER]: constructorName,
          "content-type": "application/json",
        },
      });
    }
    throw err;
  }
};
/**
 * Create a server for a stub.
 * @param instanceCreator - A function that creates an instance of the stub.
 * @param websocketHandler - A function that handles websocket connections.
 * @returns A function that handles requests to the stub.
 */
export const server = <T extends object>(
  instanceCreator: (name: string, req: Request) => Promise<T>,
): (req: Request) => Promise<Response> => {
  return async (req: Request) => {
    const url = new URL(req.url);
    const locator = invokeNameAndMethod(url.pathname);

    if (!locator) {
      return new Response(null, { status: 404 });
    }

    const objInstance = await instanceCreator(
      locator.name,
      req,
    );

    const { name: stubName, method: stubMethod } = locator;
    if (!stubMethod || !stubName) {
      return new Response(
        `method ${stubMethod} not found for the object ${stubName}`,
        { status: 404 },
      );
    }
    let args = [], metadata = {};
    if (req.headers.get("content-type")?.includes("application/json")) {
      const payload = (await req
        .json()) as any;

      if (typeof payload === "object" && "args" in payload) {
        const { args: margs, metadata: maybeMetadata } = payload;
        args = margs;
        metadata = maybeMetadata;
      } else {
        args = payload;
        metadata = {};
      }
    } else if (isFormData(req)) {
      const formData = await req.formData();
      const file = formData.get("file") as File;
      metadata = JSON.parse(formData.get("metadata") as string ?? "{}");
      args = JSON.parse(formData.get("args") as string ?? "[]");
      args = [file.stream(), ...args];
    } else if (url.searchParams.get("args")) {
      const qargs = url.searchParams.get("args");

      const parsedArgs = qargs
        ? JSON.parse(atob(decodeURIComponent(qargs)))
        : {};
      args = parsedArgs.args;
      metadata = parsedArgs.metadata;
    }
    const next = (mid: InvokeMiddlewareOptions) => {
      return invokeResponse(url, {
        instance: objInstance,
        stubName,
        methodName: mid.method,
        args: mid.args,
        metadata: mid.metadata,
        request: mid.request,
      });
    };
    const options = { args, metadata, request: req, method: stubMethod };
    if (hasInvokeMiddleware(objInstance)) {
      return objInstance.onBeforeInvoke(options, next);
    }
    return next(options);
  };
};
