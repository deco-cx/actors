import {
  type Actor,
  ACTOR_ID_HEADER_NAME,
  type ActorConstructor,
} from "./runtime.ts";

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

const ACTORS_SERVER_URL: string | undefined = Deno.env.get(
  "DENO_ACTORS_SERVER_URL",
);
const DEPLOYMENT: string | undefined = Deno.env.get("DENO_DEPLOYMENT_ID");
/**
 * utilities to create and manage actors.
 */
export const actors = {
  proxy: <TInstance extends Actor>(
    actor: ActorConstructor<TInstance> | string,
    server = ACTORS_SERVER_URL,
  ): { id: (id: string) => Promisify<TInstance> } => {
    return {
      id: (id: string): Promisify<TInstance> => {
        return new Proxy<Promisify<TInstance>>({} as Promisify<TInstance>, {
          get: (_, prop) => {
            return async (...args: unknown[]) => {
              const resp = await fetch(
                `${server}/actors/${
                  typeof actor === "string" ? actor : actor.name
                }/invoke/${String(prop)}`,
                {
                  method: "POST",
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
              return resp.json();
            };
          },
        });
      },
    };
  },
};
