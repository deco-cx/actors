import { deserializeUint8Array, serializeUint8Array } from "../buffers.ts";
import type { MessageSerializer } from "./channel.ts";

export const jsonSerializer = <TSend, TReceive>(): MessageSerializer<
  TSend,
  TReceive,
  string
> => {
  return {
    deserialize: (msg) => {
      return JSON.parse(msg, deserializeUint8Array);
    },
    serialize: (msg) => JSON.stringify(msg, serializeUint8Array),
  };
};
