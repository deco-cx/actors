import type { MessageSerializer } from "./channel.ts";

export const jsonSerializer = <TSend, TReceive>(): MessageSerializer<
  TSend,
  TReceive,
  string
> => {
  return {
    deserialize: (msg) => {
      return JSON.parse(msg);
    },
    serialize: JSON.stringify,
  };
};
