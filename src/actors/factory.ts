import {
  type Actor,
  ACTOR_ID_HEADER_NAME,
  type ActorConstructor,
} from "./runtime.ts";

export interface ProxyOptions<TInstance extends Actor> {
  actor: ActorConstructor<TInstance>;
  server: string;
}

type Promisify<Actor> = {
  [key in keyof Actor]: Actor[key] extends (...args: infer Args) => infer Return
    ? Return extends Promise<unknown> ? Actor[key]
    : (...args: Args) => Promise<Return>
    : Actor[key];
};
export const actors = {
  proxy: <TInstance extends Actor>(c: ProxyOptions<TInstance>) => {
    return {
      id: (id: string): Promisify<TInstance> => {
        return new Proxy<Promisify<TInstance>>({} as Promisify<TInstance>, {
          get: (_, prop) => {
            return async (...args: unknown[]) => {
              const resp = await fetch(
                `${c.server}/actors/${c.actor.name}/invoke/${String(prop)}`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    [ACTOR_ID_HEADER_NAME]: id,
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
