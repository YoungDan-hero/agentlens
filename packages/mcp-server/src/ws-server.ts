import { isSnapshotResponse, PROTOCOL_VERSION, WS_PATH } from '@agentlensjs/shared';
import type { AgentLensEvent, SnapshotRequest, SnapshotResponse } from '@agentlensjs/shared';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RawData } from 'ws';
import { WebSocketServer, WebSocket } from 'ws';

import { isAllowedOrigin } from './origin';
import type { StackResolver } from './stack-resolver';
import type { EventStore } from './store';
import { parseEvent } from './validate';

const SNAPSHOT_TIMEOUT_MS = 5000;
const BIND_RETRY_DELAY_MS = 500;
const BIND_MAX_RETRIES = 10;

export interface WsIngestServer {
  /**
   * Asks a connected browser session for a structured layout snapshot.
   * Targets the given session when provided, otherwise the most recently
   * active connection. Rejects when no browser is connected or the browser
   * does not answer within the timeout.
   */
  requestSnapshot: (sessionId?: string, timeoutMs?: number) => Promise<SnapshotResponse>;
  close: () => Promise<void>;
}

export interface WsIngestServerOptions {
  /** Delay between bind retries when the port is still occupied. */
  bindRetryDelayMs?: number;
  /** How many times to retry binding before giving up. */
  bindMaxRetries?: number;
  /** Called when the server cannot recover. Defaults to `process.exit`. */
  onFatal?: (code: number) => void;
  /**
   * Extra `Origin` header values allowed to connect, on top of the
   * built-in local allowances (loopback, `*.localhost`, RFC 1918 hosts).
   */
  allowedOrigins?: readonly string[];
}

interface ConnectionInfo {
  sessionId: string | null;
  lastActivityAt: number;
  /** Diagnostics are logged once per connection to avoid stderr storms. */
  warnedVersionMismatch: boolean;
  warnedMalformedEvents: boolean;
}

/** Envelope shape check; individual events are validated separately. */
interface Envelope {
  protocolVersion: number;
  events: unknown[];
}

function parseEnvelope(value: unknown): Envelope | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { protocolVersion?: unknown; events?: unknown };
  if (typeof candidate.protocolVersion !== 'number' || !Array.isArray(candidate.events)) {
    return null;
  }
  return { protocolVersion: candidate.protocolVersion, events: candidate.events };
}

/**
 * Resolves raw stacks to source coordinates after the event is stored.
 * Runs asynchronously and mutates the stored event in place, so queries
 * stay fast and pick up frames as soon as resolution completes.
 */
function resolveStacks(event: AgentLensEvent, resolver: StackResolver): void {
  if (event.type === 'error') {
    void resolver.resolve(event.stack).then((frames) => {
      event.frames = frames;
    });
  } else if (event.type === 'network') {
    void resolver.resolve(event.initiatorStack).then((frames) => {
      event.initiatorFrames = frames;
    });
  }
}

/**
 * Accepts WebSocket connections from `@agentlensjs/runtime` instances,
 * ingests their event batches into the store, and serves as the daemon-side
 * endpoint for request/response exchanges such as layout snapshots.
 */
export function startWsIngestServer(
  store: EventStore,
  port: number,
  resolver?: StackResolver,
  options: WsIngestServerOptions = {},
): WsIngestServer {
  const bindRetryDelayMs = options.bindRetryDelayMs ?? BIND_RETRY_DELAY_MS;
  const bindMaxRetries = options.bindMaxRetries ?? BIND_MAX_RETRIES;
  const onFatal = options.onFatal ?? ((code: number) => process.exit(code));
  const allowedOrigins = options.allowedOrigins ?? [];
  const rejectedOrigins = new Set<string>();

  const connections = new Map<WebSocket, ConnectionInfo>();
  const pendingSnapshots = new Map<
    string,
    { resolve: (response: SnapshotResponse) => void; timer: NodeJS.Timeout }
  >();

  let wss: WebSocketServer;
  let bindAttempts = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const handleConnection = (socket: WebSocket): void => {
    connections.set(socket, {
      sessionId: null,
      lastActivityAt: Date.now(),
      warnedVersionMismatch: false,
      warnedMalformedEvents: false,
    });

    socket.on('close', () => {
      connections.delete(socket);
    });

    socket.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }

      if (isSnapshotResponse(message)) {
        const pending = pendingSnapshots.get(message.requestId);
        if (pending) {
          pendingSnapshots.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        return;
      }

      const envelope = parseEnvelope(message);
      if (!envelope) {
        return;
      }
      const info = connections.get(socket);

      // Never silently drop a whole client: a version skew between runtime
      // and daemon must be diagnosable from the daemon log.
      if (envelope.protocolVersion !== PROTOCOL_VERSION) {
        if (info && !info.warnedVersionMismatch) {
          info.warnedVersionMismatch = true;
          console.error(
            `[agentlens] dropping events from a client speaking protocol ` +
              `v${String(envelope.protocolVersion)}; this daemon speaks ` +
              `v${String(PROTOCOL_VERSION)}. Update @agentlensjs/runtime (or the ` +
              `Vite plugin) and @agentlensjs/mcp-server to matching versions.`,
          );
        }
        return;
      }

      if (info) {
        info.lastActivityAt = Date.now();
      }
      for (const rawEvent of envelope.events) {
        const event = parseEvent(rawEvent);
        if (!event) {
          if (info && !info.warnedMalformedEvents) {
            info.warnedMalformedEvents = true;
            console.error(
              '[agentlens] dropped malformed event(s) from a connected client; ' +
                'payloads that fail schema validation are never stored.',
            );
          }
          continue;
        }
        if (info) {
          info.sessionId = event.sessionId;
        }
        const stored = store.add(event);
        // Folded duplicates reuse the canonical record's resolved frames.
        if (resolver && stored === event) {
          resolveStacks(event, resolver);
        }
      }
    });
  };

  const listen = (): void => {
    // Loopback only: events arrive unauthenticated, so the ingest endpoint
    // must never be reachable from other machines on the network.
    wss = new WebSocketServer({
      host: '127.0.0.1',
      port,
      path: WS_PATH,
      // Loopback binding does not stop pages: any website in the user's
      // browser can attempt a WebSocket handshake to 127.0.0.1. The Origin
      // header is browser-controlled and unforgeable, so gate on it.
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
        const origin = info.req.headers.origin;
        if (isAllowedOrigin(origin, allowedOrigins)) {
          return true;
        }
        if (origin !== undefined && !rejectedOrigins.has(origin)) {
          rejectedOrigins.add(origin);
          console.error(
            `[agentlens] rejected a WebSocket connection from disallowed ` +
              `origin "${origin}". Local dev origins are allowed automatically; ` +
              `trust additional ones via AGENTLENS_ALLOWED_ORIGINS.`,
          );
        }
        return false;
      },
    });

    wss.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && bindAttempts < bindMaxRetries && !closed) {
        // MCP reloads race the previous daemon's shutdown: the old process
        // may still hold the port for a moment. Retrying rides that out
        // instead of killing the whole MCP server on the first collision.
        bindAttempts += 1;
        console.error(
          `[agentlens] port ${String(port)} is busy — retrying bind ` +
            `(${String(bindAttempts)}/${String(bindMaxRetries)})...`,
        );
        wss.close();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!closed) {
            listen();
          }
        }, bindRetryDelayMs);
        return;
      }
      if (error.code === 'EADDRINUSE') {
        console.error(
          `[agentlens] port ${String(port)} is still in use after ` +
            `${String(bindMaxRetries)} retries — is another AgentLens daemon ` +
            'running? Stop it or set AGENTLENS_PORT.',
        );
      } else {
        console.error('[agentlens] ingest server error:', error);
      }
      onFatal(1);
    });

    wss.on('listening', () => {
      bindAttempts = 0;
      console.error(`[agentlens] ingesting on ws://127.0.0.1:${String(port)}${WS_PATH}`);
    });

    wss.on('connection', handleConnection);
  };

  listen();

  function pickSocket(sessionId?: string): WebSocket | null {
    let best: WebSocket | null = null;
    let bestActivity = -1;
    for (const [socket, info] of connections) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (sessionId !== undefined && info.sessionId !== sessionId) {
        continue;
      }
      if (info.lastActivityAt > bestActivity) {
        best = socket;
        bestActivity = info.lastActivityAt;
      }
    }
    return best;
  }

  return {
    requestSnapshot: (sessionId?: string, timeoutMs: number = SNAPSHOT_TIMEOUT_MS) => {
      const socket = pickSocket(sessionId);
      if (!socket) {
        return Promise.reject(
          new Error(
            sessionId === undefined
              ? 'No browser session is connected to the daemon.'
              : `No connected browser matches session "${sessionId}".`,
          ),
        );
      }
      const request: SnapshotRequest = { kind: 'snapshot-request', requestId: randomUUID() };
      return new Promise<SnapshotResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingSnapshots.delete(request.requestId);
          reject(new Error('The browser did not answer the snapshot request in time.'));
        }, timeoutMs);
        pendingSnapshots.set(request.requestId, { resolve, timer });
        socket.send(JSON.stringify(request));
      });
    },
    close: () =>
      new Promise((resolve, reject) => {
        closed = true;
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        for (const pending of pendingSnapshots.values()) {
          clearTimeout(pending.timer);
        }
        pendingSnapshots.clear();
        for (const socket of connections.keys()) {
          socket.close();
        }
        wss.close((error) => {
          // "not running" just means the bind never succeeded; that is a
          // clean state for shutdown, not a failure.
          if (error && !error.message.includes('not running')) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

function rawDataToString(raw: RawData): string {
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}
