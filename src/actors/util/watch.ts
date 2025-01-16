import { Broadcaster } from "./channels/channel.ts";

export type {
  Broadcaster,
  ChannelUpgrader,
  DuplexChannel,
} from "./channels/channel.ts";

export class WatchTarget<T> extends Broadcaster<T> {}
