import {
  type Actor,
  ACTOR_ID_HEADER_NAME,
  type ActorConstructor,
} from "./runtime.ts";
import { EVENT_STREAM_RESPONSE_HEADER, readFromStream } from "./stream.ts";

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

const DECO_ACTORS_SERVER_URL: string | undefined = Deno.env.get(
  "DECO_ACTORS_SERVER_URL",
);
const DEPLOYMENT: string | undefined = Deno.env.get("DENO_DEPLOYMENT_ID");
const ACTORS_SERVER_URL = DECO_ACTORS_SERVER_URL ??
  (typeof DEPLOYMENT === "string"
    ? undefined
    : `http://localhost:${Deno.env.get("PORT") ?? 8000}`);

/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    server: string | undefined = ACTORS_SERVER_URL,
  ): { id: (id: string) => Promisify<TInstance> } => {
    return {
      id: (id: string): Promisify<TInstance> => {
        return new Proxy<Promisify<TInstance>>({} as Promisify<TInstance>, {
          get: (_, prop) => {
            return async (...args: unknown[]) => {
              const abortCtrl = new AbortController();
              const resp = await fetch(
                `${server}/actors/${
                  typeof actor === "string" ? actor : actor.name
                }/invoke/${String(prop)}`,
                {
                  method: "POST",
                  signal: abortCtrl.signal,
                  headers: {
                    "Content-Type": "application/json",
                    [ACTOR_ID_HEADER_NAME]: id,
                    ...DEPLOYMENT
                      ? { ["x-deno-deployment-id"]: DEPLOYMENT }
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
