// deno-lint-ignore-file no-explicit-any
// Define event interfaces
interface WebSocketEventMap {
  close: CloseEvent;
  error: ErrorEvent;
  message: MessageEvent;
  open: Event;
}

interface WebSocketEventListener<K extends keyof WebSocketEventMap> {
  (event: WebSocketEventMap[K]): void;
}

export class WebSocketWrapper implements WebSocket {
  private socket: Socket;
  private readableStreamReader: ReadableStreamDefaultReader;
  private writableStreamWriter: WritableStreamDefaultWriter;

  public readyState: number;
  public bufferedAmount: number = 0;
  public extensions: string = "";
  public protocol: string = "";
  public url: string = "";
  public binaryType: BinaryType = "blob";

  // Event handlers
  public onclose: ((event: CloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onopen: ((event: Event) => void) | null = null;

  private eventListeners: Map<
    keyof WebSocketEventMap,
    Set<WebSocketEventListener<any>>
  > = new Map();

  constructor(socket: Socket) {
    this.socket = socket;
    this.readableStreamReader = socket.readable.getReader();
    this.writableStreamWriter = socket.writable.getWriter();
    this.readyState = 0; // CONNECTING

    // Initialize the connection
    this.initialize();
  }
  CONNECTING: 0 = 0;
  OPEN: 1 = 1;
  CLOSING: 2 = 2;
  CLOSED: 3 = 3;
  accept(): void {
    throw new Error("Method not implemented.");
  }
  serializeAttachment(_attachment: unknown): void {
    throw new Error("Method not implemented.");
  }
  deserializeAttachment() {
    throw new Error("Method not implemented.");
  }

  private async initialize(): Promise<void> {
    try {
      // Wait for the socket to open
      await this.socket.opened;

      // Since we don't have webSocketAccepted, we assume the connection is established
      // when opened resolves successfully
      this.readyState = 1; // OPEN
      this.dispatchEvent(new Event("open"));

      // Start reading from the socket
      this.startReading();
    } catch (error) {
      this.handleError(error);
    }
  }

  private async startReading(): Promise<void> {
    try {
      while (true) {
        const { value, done } = await this.readableStreamReader.read();
        if (done) break;

        const event = new MessageEvent("message", {
          data: value,
          origin: this.url,
          lastEventId: "",
          source: null,
          ports: [],
        });

        this.dispatchEvent(event);
      }
    } catch (error) {
      this.handleError(error);
    } finally {
      this.handleClose(1000, "Connection closed normally");
    }
  }

  private handleError(error: any): void {
    const errorEvent = new ErrorEvent("error", {
      error,
      message: error.message,
    });

    this.dispatchEvent(errorEvent);
  }

  private handleClose(code: number, reason: string): void {
    this.readyState = 3; // CLOSED

    const closeEvent = new CloseEvent("close", {
      wasClean: true,
      code,
      reason,
    });

    this.dispatchEvent(closeEvent);
  }

  // WebSocket API methods
  public async send(
    data: string | ArrayBufferLike | Blob | ArrayBufferView,
  ): Promise<void> {
    if (this.readyState !== 1) {
      throw new Error("WebSocket is not open");
    }

    try {
      await this.writableStreamWriter.write(data);
    } catch (error) {
      this.handleError(error);
    }
  }

  public async close(code: number = 1000, reason: string = ""): Promise<void> {
    if (this.readyState === 3) return; // Already closed

    try {
      await this.writableStreamWriter.close();
      await this.readableStreamReader.cancel();
      await this.socket.close();
      this.handleClose(code, reason);
    } catch (error) {
      this.handleError(error);
    }
  }

  // Event handling
  public addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: WebSocketEventListener<K>,
  ): void {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    this.eventListeners.get(type)!.add(listener);
  }

  public removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: WebSocketEventListener<K>,
  ): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  public dispatchEvent(event: Event): boolean {
    // Call the specific handler if it exists
    const handlerName = `on${event.type}` as keyof WebSocketWrapper;
    const handler = this[handlerName] as ((event: any) => void) | null;
    if (handler) {
      handler.call(this, event);
    }

    // Call all registered event listeners
    const listeners = this.eventListeners.get(
      event.type as keyof WebSocketEventMap,
    );
    if (listeners) {
      listeners.forEach((listener) => listener(event as any));
    }

    return true;
  }
}
