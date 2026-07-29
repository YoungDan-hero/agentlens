import type { AgentLensEvent, ProtocolMessage } from '@agentlens/shared';
import { PROTOCOL_VERSION } from '@agentlens/shared';

export interface TransportOptions {
  /** Full WebSocket endpoint, e.g. `ws://localhost:8631/agentlens`. */
  endpoint: string;
  /** Max events buffered while the socket is down. Oldest are dropped first. */
  maxQueueSize?: number;
}

const DEFAULT_MAX_QUEUE = 500;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * Buffered WebSocket transport with exponential-backoff reconnection.
 * Events emitted while disconnected are queued and flushed on reconnect,
 * so signals produced during daemon restarts are not lost.
 */
export class Transport {
  private socket: WebSocket | null = null;
  private queue: AgentLensEvent[] = [];
  private reconnectAttempts = 0;
  private closed = false;

  private readonly endpoint: string;
  private readonly maxQueueSize: number;

  constructor(options: TransportOptions) {
    this.endpoint = options.endpoint;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE;
    this.connect();
  }

  send(event: AgentLensEvent): void {
    if (this.closed) {
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.flush([event]);
      return;
    }
    this.queue.push(event);
    if (this.queue.length > this.maxQueueSize) {
      this.queue.shift();
    }
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      if (this.queue.length > 0) {
        const pending = this.queue;
        this.queue = [];
        this.flush(pending);
      }
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

  private flush(events: AgentLensEvent[]): void {
    const message: ProtocolMessage = {
      protocolVersion: PROTOCOL_VERSION,
      events,
    };
    this.socket?.send(JSON.stringify(message));
  }
}
