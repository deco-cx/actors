import { Queue } from "@core/asyncutil/queue";
import { jsonSerializer } from "./serializers.ts";

export interface Channel<T> {
  closed: Promise<void>;
  signal: AbortSignal;
  close(): void;
  send(value: T): Promise<void>;
  recv(signal?: AbortSignal): AsyncIterableIterator<T>;
}

/**
 * Checks if a value is a channel.
 *
 * @param v - The value to check.
 *
 * @returns True if the value is a channel, false otherwise.
 */
export const isChannel = <
  T,
  TChannel extends Channel<T> = Channel<T>,
>(v: TChannel | unknown): v is TChannel => {
  return typeof (v as TChannel).recv === "function" &&
    typeof (v as TChannel).send === "function";
};

/**
 * Checks if a value is a channel upgrader.
 *
 * @param v - The value to check.
 *
 * @returns True if the value is a channel upgrader, false otherwise.
 */
export const isUpgrade = (
  v: ChannelUpgrader<unknown, unknown> | unknown,
): v is ChannelUpgrader<unknown, unknown> => {
  return typeof (v as ChannelUpgrader<unknown, unknown>) === "function";
};

/**
 * Links multiple abort signals together such that when any of them
 * are aborted, the returned signal is also aborted.
 *
 * @param signals - The abort signals to link together.
 *
 * @returns The linked abort signal.
 */
export const link = (...signals: AbortSignal[]): AbortSignal => {
  return AbortSignal.any(signals);
};

export class ClosedChannelError extends Error {
  constructor() {
    super("Channel is closed");
  }
}
export const ifClosedChannel =
  (cb: () => Promise<void> | void) => (err: unknown) => {
    if (err instanceof ClosedChannelError) {
      return cb();
    }
    throw err;
  };

export const ignoreIfClosed = ifClosedChannel(() => {});
export const makeChan = <T>(capacity = 0): Channel<T> => {
  let currentCapacity = capacity;
  const queue: Queue<{ value: T; resolve: () => void }> = new Queue();
  const ctrl = new AbortController();
  const abortPromise = Promise.withResolvers<void>();
  ctrl.signal.onabort = () => {
    abortPromise.resolve();
  };

  const send = (value: T): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (ctrl.signal.aborted) reject(new ClosedChannelError());
      let mResolve = resolve;
      if (currentCapacity > 0) {
        currentCapacity--;
        mResolve = () => {
          currentCapacity++;
        };
        resolve();
      }
      queue.push({ value, resolve: mResolve });
    });
  };

  const close = () => {
    ctrl.abort();
  };

  const recv = async function* (
    signal?: AbortSignal,
  ): AsyncIterableIterator<T> {
    const linked = signal ? link(ctrl.signal, signal) : ctrl.signal;
    while (true) {
      if (linked.aborted) {
        return;
      }
      try {
        const next = await queue.pop({ signal: linked });
        next.resolve();
        yield next.value;
      } catch (_err) {
        if (linked.aborted) {
          return;
        }
        throw _err;
      }
    }
  };

  return {
    send,
    recv,
    close,
    signal: ctrl.signal,
    closed: abortPromise.promise,
  };
};

export interface DuplexChannel<TSend, TReceive> extends Disposable {
  send: Channel<TSend>["send"];
  recv: Channel<TReceive>["recv"];
  close: () => void | Promise<void>;
  closed: Promise<void>;
  signal: AbortSignal;
}

/**
 * A function that upgrades a channel.
 */
export type ChannelUpgrader<TSend, TReceive = TSend> = (
  ch: DuplexChannel<TSend, TReceive>,
) => Promise<void> | void;

// deno-lint-ignore no-explicit-any
export type Message<TMessageProperties = any> = TMessageProperties & {
  chunk?: Uint8Array;
};

export interface MessageSerializer<
  TSend,
  TReceive,
  TRawFormat extends string | ArrayBufferLike | ArrayBufferView | Blob,
> {
  binaryType?: BinaryType;
  serialize: (
    msg: Message<TSend>,
  ) => TRawFormat;
  deserialize: (str: TRawFormat) => Message<TReceive>;
}

export const makeWebSocket = <
  TSend,
  TReceive,
  TMessageFormat extends string | ArrayBufferLike | ArrayBufferView | Blob =
    | string
    | ArrayBufferLike
    | ArrayBufferView
    | Blob,
>(
  socket: WebSocket,
  _serializer?: MessageSerializer<TSend, TReceive, TMessageFormat>,
): Promise<DuplexChannel<Message<TSend>, Message<TReceive>>> => {
  const serializer = _serializer ??
    jsonSerializer<Message<TSend>, Message<TReceive>>();
  const sendChan = makeChan<Message<TSend>>();
  const recvChan = makeChan<Message<TReceive>>();
  const ch = Promise.withResolvers<
    DuplexChannel<Message<TSend>, Message<TReceive>>
  >();
  socket.binaryType = serializer.binaryType ?? "blob";
  socket.onclose = () => {
    sendChan.close();
    recvChan.close();
  };
  socket.onerror = (err) => {
    socket.close();
    ch.reject(err);
  };
  socket.onmessage = async (msg) => {
    if (recvChan.signal.aborted) {
      return;
    }
    await recvChan.send(serializer.deserialize(msg.data));
  };
  socket.onopen = async () => {
    ch.resolve({
      closed: Promise.race([recvChan.closed, sendChan.closed]),
      signal: link(recvChan.signal, sendChan.signal),
      recv: recvChan.recv.bind(recvChan),
      send: sendChan.send.bind(recvChan),
      close: () => socket.close(),
      [Symbol.dispose]: () => socket.close(),
    });
    for await (const message of sendChan.recv()) {
      try {
        socket.send(
          serializer.serialize(message),
        );
      } catch (_err) {
        console.error("error sending message through socket", _err, message);
      }
    }
    socket.close();
  };
  return ch.promise;
};

/**
 * Creates a new duplex channel.
 * @param upgrader the channel upgrader
 * @returns a created duplex channel
 */
export const makeDuplexChannel = <TSend, TReceive>(
  upgrader?: ChannelUpgrader<TSend, TReceive>,
): DuplexChannel<TSend, TReceive> => {
  // Create internal send and receive channels
  const sendChan = makeChan<TSend>();
  const recvChan = makeChan<TReceive>();

  const duplexChannel: DuplexChannel<TSend, TReceive> = {
    closed: Promise.race([recvChan.closed, sendChan.closed]),
    signal: link(sendChan.signal, recvChan.signal),
    send: sendChan.send.bind(sendChan),
    recv: recvChan.recv.bind(recvChan),
    close: () => {
      sendChan.close();
      recvChan.close();
    },
    [Symbol.dispose]: () => {
      sendChan.close();
      recvChan.close();
    },
  };

  // If there's an upgrader, we upgrade the duplex channel
  if (upgrader && isUpgrade(upgrader)) {
    upgrader({
      closed: duplexChannel.closed,
      signal: duplexChannel.signal,
      send: recvChan.send.bind(recvChan),
      recv: sendChan.recv.bind(sendChan),
      close: duplexChannel.close,
      [Symbol.dispose]: duplexChannel[Symbol.dispose],
    });
  }

  return duplexChannel;
};
