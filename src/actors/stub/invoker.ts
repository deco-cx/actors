import { StubError } from "../errors.ts";
import { rpc } from "../rpc.ts";
import { isUpgrade, makeDuplexChannel } from "../util/channels/channel.ts";
import {
  type BaseMetadata,
  type EnrichMetadataFn,
  WELL_KNOWN_RPC_MEHTOD,
} from "./stubutil.ts";

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

const isWellKnownEnrichMetadataMethod = (methodName: string) =>
  methodName === WELL_KNOWN_ENRICH_METADATA_METHOD;

const isWellKnownRPCMethod = (methodName: string) =>
  methodName === WELL_KNOWN_RPC_MEHTOD;

export interface InvokeOptions<TInstance extends object> {
  instance: TInstance;
  stubName: string;
  methodName: string;
  args: unknown[];
  metadata: unknown;
  connect?: true;
  request?: Request;
}
const PRIVATE_METHOD_PREFIX = "_";
/**
 * Invoke a method on a stub instance.
 */
export const invoke = async <TInstance extends object>(
  { request: req, connect, instance, stubName, methodName, args, metadata }:
    InvokeOptions<TInstance>,
) => {
  if (methodName.startsWith(PRIVATE_METHOD_PREFIX)) {
    throw new StubError(
      `method ${methodName} not found on actor ${stubName}`,
      "METHOD_NOT_FOUND",
    );
  }
  const method = KNOWN_METHODS[methodName] ?? methodName;
  metadata = WELL_KNOWN_ENRICH_METADATA_METHOD in instance && req
    ? await (instance.enrichMetadata as EnrichMetadataFn<unknown>)(
      metadata,
      req,
    )
    : metadata;

  if (isWellKnownRPCMethod(String(method))) {
    const chan = rpc({
      // @ts-ignore: this is a hack to make the invoke method work
      invoke: (name, method, args, metadata, connect) =>
        invoke({
          instance,
          stubName: name,
          methodName: method,
          args,
          metadata,
          connect,
          request: req,
        }),
    }, metadata);
    return chan;
  }

  if (metadata && typeof metadata === "object" && req) {
    (metadata as BaseMetadata).signal = req?.signal;
  }
  if (
    // EnrichMetadata is not supported to be called externally
    isWellKnownEnrichMetadataMethod(String(method)) ||
    !(method in instance)
  ) {
    throw new StubError(
      `method ${methodName} not found on actor ${stubName}`,
      "METHOD_NOT_FOUND",
    );
  }

  const methodImpl = instance[method as keyof typeof instance];

  if (!isInvocable(methodImpl)) {
    throw new StubError(
      `method ${methodName} is not invocable on actor ${stubName}`,
      "METHOD_NOT_INVOCABLE",
    );
  }

  const actorStub = new Proxy(instance, {
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
};
