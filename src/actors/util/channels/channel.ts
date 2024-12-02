// deno-lint-ignore-file no-explicit-any
import { Queue } from "./queue.ts";
import { jsonSerializer } from "./serializers.ts";

/**
 * Represents a channel for asynchronous communication.
 */
export interface Channel<T> {
  closed: Promise<void>;
  signal: AbortSignal;
  close(): void;
  send(value: T): Promise<void>;
  recv(signal?: AbortSignal): AsyncIterableIterator<T>;
}

/**
 * Error thrown when attempting to interact with a closed channel.
 */
export class ClosedChannelError extends Error {
  static readonly instance = new ClosedChannelError();
  private constructor() {
    super("Channel is closed");
  }
}

/**
 * Checks if a value is a channel.
 *
 * @param v - The value to check.
 * @returns True if the value is a channel, false otherwise.
 */
export const isChannel = <T>(v: unknown): v is Channel<T> => {
  return v != null &&
    typeof (v as Channel<T>).recv === "function" &&
    typeof (v as Channel<T>).send === "function";
};

/**
 * Checks if a value is a channel upgrader.
 *
 * @param v - The value to check.
 * @returns True if the value is a channel upgrader, false otherwise.
 */
export const isUpgrade = (
  v: unknown,
): v is ChannelUpgrader<unknown, unknown> => {
  return typeof v === "function";
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
  if (signals.length === 1) {
    return signals[0];
  }
  const ctrl = new AbortController();
  for (const signal of signals) {
    signal.addEventListener("abort", (evt) => {
      if (!ctrl.signal.aborted) {
        ctrl.abort(evt);
      }
    }, { once: true });
  }
  return ctrl.signal;
};

/**
 * Creates a handler for closed channel errors.
 *
 * @param cb - Callback to execute when a closed channel error is caught.
 */
export const ifClosedChannel =
  (cb: () => Promise<void> | void) => (err: unknown) => {
    if (err instanceof ClosedChannelError) return cb();
    throw err;
  };

/**
 * Utility function to ignore closed channel errors.
 */
export const ignoreIfClosed = ifClosedChannel(() => {});

/**
 * Creates a new channel with the specified capacity.
 *
 * @param capacity - The buffer capacity of the channel (default: 0).
 * @returns A new channel instance.
 */
export const makeChan = <T>(capacity = 0): Channel<T> => {
  const queue = new Queue<{ value: T; resolve: () => void }>();
  const ctrl = new AbortController();
  const { promise: closed, resolve: resolveClose } = Promise.withResolvers<
    void
  >();

  ctrl.signal.addEventListener("abort", () => resolveClose(), { once: true });

  const send = (value: T): Promise<void> => {
    if (ctrl.signal.aborted) throw ClosedChannelError.instance;

    if (capacity > 0) {
      if (queue.size < capacity) {
        queue.push({ value, resolve: () => {} });
        return Promise.resolve();
      }
    }

    return new Promise<void>((resolve) => {
      queue.push({ value, resolve });
    });
  };

  const close = () => ctrl.abort();

  async function* recv(signal?: AbortSignal): AsyncIterableIterator<T> {
    const linked = signal ? link(ctrl.signal, signal) : ctrl.signal;

    try {
      while (!linked.aborted) {
        const next = await queue.pop({ signal: linked });
        next.resolve();
        yield next.value;
      }
    } catch (err) {
      if (!linked.aborted) throw err;
    }
  }

  return {
    send,
    recv,
    close,
    signal: ctrl.signal,
    closed,
  };
};

/**
 * Represents a bidirectional channel.
 */
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

/**
 * Represents a message that can be sent through a channel.
 */
export type Message<TMessageProperties = any> = TMessageProperties & {
  chunk?: Uint8Array;
};

/**
 * Interface for message serialization/deserialization.
 */
export interface MessageSerializer<
  TSend,
  TReceive,
  TRawFormat extends string | ArrayBufferLike | ArrayBufferView | Blob,
> {
  binaryType?: BinaryType;
  serialize: (msg: Message<TSend>) => TRawFormat;
  deserialize: (str: TRawFormat) => Message<TReceive>;
}

/**
 * Creates a WebSocket-based duplex channel.
 *
 * @param socket - The WebSocket instance to use.
 * @param _serializer - Optional message serializer.
 * @returns A promise that resolves to a duplex channel.
 */
export const makeWebSocket = <
  TSend,
  TReceive,
  TMessageFormat extends string | ArrayBufferLike | ArrayBufferView | Blob,
>(
  socket: WebSocket,
  _serializer?: MessageSerializer<TSend, TReceive, TMessageFormat>,
): Promise<DuplexChannel<Message<TSend>, Message<TReceive>>> => {
  const serializer = _serializer ??
    jsonSerializer<Message<TSend>, Message<TReceive>>();
  const sendChan = makeChan<Message<TSend>>();
  const recvChan = makeChan<Message<TReceive>>();
  const { promise, resolve, reject } = Promise.withResolvers<
    DuplexChannel<Message<TSend>, Message<TReceive>>
  >();

  socket.binaryType = serializer.binaryType ?? "blob";

  const cleanup = () => {
    sendChan.close();
    recvChan.close();
  };

  socket.onclose = cleanup;
  socket.onerror = (err) => {
    socket.close();
    reject(err);
  };

  socket.onmessage = (msg) => {
    if (!recvChan.signal.aborted) {
      recvChan.send(serializer.deserialize(msg.data)).catch(console.error);
    }
  };

  socket.onopen = () => {
    const channel: DuplexChannel<Message<TSend>, Message<TReceive>> = {
      closed: Promise.race([recvChan.closed, sendChan.closed]),
      signal: link(recvChan.signal, sendChan.signal),
      recv: recvChan.recv.bind(recvChan),
      send: sendChan.send.bind(recvChan),
      close: () => socket.close(),
      [Symbol.dispose]: () => socket.close(),
    };

    resolve(channel);

    (async () => {
      try {
        for await (const message of sendChan.recv()) {
          socket.send(serializer.serialize(message));
        }
      } catch (err) {
        console.error("Error in send loop:", err);
      } finally {
        socket.close();
      }
    })();
  };

  socket?.accept?.();
  return promise;
};

/**
 * Creates a new duplex channel with existing channels.
 *
 * @param sendChan - The channel to use for sending.
 * @param recvChan - The channel to use for receiving.
 * @param upgrader - Optional channel upgrader.
 * @returns A new duplex channel.
 */
export const makeDuplexChannelWith = <TSend, TReceive>(
  sendChan: Channel<TSend>,
  recvChan: Channel<TReceive>,
  upgrader?: ChannelUpgrader<TSend, TReceive>,
): DuplexChannel<TSend, TReceive> => {
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

/**
 * Creates a new duplex channel.
 *
 * @param upgrader - Optional channel upgrader.
 * @returns A new duplex channel.
 */
export const makeDuplexChannel = <TSend, TReceive>(
  upgrader?: ChannelUpgrader<TSend, TReceive>,
): DuplexChannel<TSend, TReceive> => {
  return makeDuplexChannelWith(
    makeChan<TSend>(),
    makeChan<TReceive>(),
    upgrader,
  );
};
