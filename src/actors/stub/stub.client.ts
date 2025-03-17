import type { StubServerOptions } from "./stub.ts";
import type { StubFactory } from "./stubutil.ts";
import { create, createHttpInvoker } from "./stubutil.ts";

export interface CreateStubFactoryOptions<TArgs extends unknown[]>
  extends StubServerOptions {
  useRequest?: (request: Request, ...args: TArgs) => Request;
  useWebsocketUrl?: (url: URL, ...args: TArgs) => URL;
}

/**
 * Create a stub factory for a given actor or stub.
 * @param stub - The actor or stub to create a factory for.
 * @param options - Options for the stub factory.
 * @returns A stub factory for the given actor or stub.
 */
export const stub = <T, TArgs extends unknown[]>(
  stub: { name: string } | string,
  options?: CreateStubFactoryOptions<TArgs> | undefined,
): StubFactory<T, TArgs> => {
  const factory = (...args: TArgs) =>
    createHttpInvoker({
      useRequest: (req) => options?.useRequest?.(req, ...args) ?? req,
      useWebsocketUrl: (url) => options?.useWebsocketUrl?.(url, ...args) ?? url,
    }, options);

  return create(stub, factory);
};
