import type { AgentLensEvent, ProtocolMessage } from '@agentlensjs/shared';
import { PROTOCOL_VERSION } from '@agentlensjs/shared';

/** Anything that can receive events; lets collectors be tested in isolation. */
export interface EventSink {
  send: (event: AgentLensEvent) => void;
}

export interface TransportOptions {
  /** Full WebSocket endpoint, e.g. `ws://localhost:8631/agentlens`. */
  endpoint: string;
  /** Max events buffered while the socket is down. Oldest are dropped first. */
  maxQueueSize?: number;
  /** Micro-batching window: events within it ship as one message. */
  batchWindowMs?: number;
  /** A full batch flushes immediately without waiting for the window. */
  maxBatchSize?: number;
  /** Called for every JSON message the daemon pushes down the socket. */
  onMessage?: (message: unknown) => void;
}

const DEFAULT_MAX_QUEUE = 500;
const DEFAULT_BATCH_WINDOW_MS = 100;
const DEFAULT_MAX_BATCH_SIZE = 50;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * Buffered WebSocket transport with micro-batching and exponential-backoff
 * reconnection. Events within the batch window ship as a single message, so
 * error storms don't translate into a socket-frame storm. Events emitted
 * while disconnected stay queued (bounded) and flush on reconnect.
 */
export class Transport implements EventSink {
  private socket: WebSocket | null = null;
  private queue: AgentLensEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;

  private readonly endpoint: string;
  private readonly maxQueueSize: number;
  private readonly batchWindowMs: number;
  private readonly maxBatchSize: number;
  private readonly onMessage: ((message: unknown) => void) | undefined;

  constructor(options: TransportOptions) {
    this.endpoint = options.endpoint;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE;
    this.batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.onMessage = options.onMessage;
    this.connect();
  }

  send(event: AgentLensEvent): void {
    if (this.closed) {
      return;
    }
    this.queue.push(event);
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift();
    }
    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  /**
   * Sends a payload immediately, bypassing the batch queue. Used for
   * request/response exchanges (e.g. snapshot responses) that must not be
   * delayed by the batching window. Dropped when the socket is not open.
   */
  sendRaw(payload: unknown): void {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    // Ship whatever is still sitting in the batch window before tearing
    // down, so dispose/unload does not silently drop the last events.
    this.flush();
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.batchWindowMs);
  }

  /** Sends all queued events immediately if the socket is open. */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0 || this.socket?.readyState !== WebSocket.OPEN) {
      // Not connected: events stay queued and flush on the next `open`.
      return;
    }
    const message: ProtocolMessage = {
      protocolVersion: PROTOCOL_VERSION,
      events: this.queue,
    };
    this.queue = [];
    this.socket.send(JSON.stringify(message));
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.flush();
    });

    socket.addEventListener('message', (event) => {
      if (!this.onMessage || typeof event.data !== 'string') {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage(parsed);
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) {
      return;
    }
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempts += 1;
    setTimeout(() => {
      this.connect();
    }, delay);
  }
}
