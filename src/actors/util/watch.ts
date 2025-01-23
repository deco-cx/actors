import { Broadcaster, ClosedChannelError } from "./channels/channel.ts";
export type {
  Broadcaster,
  ChannelUpgrader,
  DuplexChannel,
} from "./channels/channel.ts";
export { ClosedChannelError };

export class WatchTarget<T> extends Broadcaster<T> {}
