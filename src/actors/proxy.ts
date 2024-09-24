import type { Actor, ActorConstructor } from "./runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "./stream.ts";

export const ACTOR_ID_HEADER_NAME = "x-deno-isolate-instance-id";

/**
 * options to create a new actor proxy.
 */
export interface ProxyOptions<TInstance extends Actor> {
  actor: ActorConstructor<TInstance> | string;
  server: string;
}

type Promisify<Actor> = {
  [key in keyof Actor]: Actor[key] extends (...args: infer Args) => infer Return
    ? Return extends Promise<unknown> ? Actor[key]
    : (...args: Args) => Promise<Return>
    : Actor[key];
};

export interface ActorsServer {
  url: string;
  deploymentId?: string;
}

const IS_BROWSER = typeof document !== "undefined";

let _server: ActorsServer | null = null;
const isLayeredUrl = (url: string): boolean => url.includes("layers");
const initServer = (): ActorsServer => {
  if (IS_BROWSER) {
    return {
      url: "", // relative
    };
  }

  const deploymentId = Deno.env.get("DENO_DEPLOYMENT_ID");
  const fallbackUrl = typeof deploymentId === "string"
    ? undefined
    : `http://localhost:${Deno.env.get("PORT") ?? 8000}`;

  return {
    url: Deno.env.get(
      "DECO_ACTORS_SERVER_URL",
    ) ??
      fallbackUrl ?? "",
    deploymentId: deploymentId && isLayeredUrl(deploymentId)
      ? deploymentId
      : undefined,
  };
};

/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    server?: ActorsServer | undefined,
  ): { id: (id: string) => Promisify<TInstance> } => {
    if (!server) {
      _server ??= initServer();
    }
    const actorsServer = server ?? _server!;
    return {
      id: (id: string): Promisify<TInstance> => {
        return new Proxy<Promisify<TInstance>>({} as Promisify<TInstance>, {
          get: (_, prop) => {
            return async (...args: unknown[]) => {
              const abortCtrl = new AbortController();
              const resp = await fetch(
                `${actorsServer.url}/actors/${
                  typeof actor === "string" ? actor : actor.name
                }/invoke/${String(prop)}`,
                {
                  method: "POST",
                  signal: abortCtrl.signal,
                  headers: {
                    "Content-Type": "application/json",
                    [ACTOR_ID_HEADER_NAME]: id,
                    ...actorsServer.deploymentId
                      ? { ["x-deno-deployment-id"]: actorsServer.deploymentId }
                      : {},
                  },
                  body: JSON.stringify({
                    args,
                  }),
                },
              );
              if (
                resp.headers.get("content-type") ===
                  EVENT_STREAM_RESPONSE_HEADER
              ) {
                const iterator = readFromStream(resp);
                const retn = iterator.return;
                iterator.return = function (val) {
                  abortCtrl.abort();
                  return retn?.call(iterator, val) ?? val;
                };
                return iterator;
              }
              return resp.json();
            };
          },
        });
      },
    };
  },
};
