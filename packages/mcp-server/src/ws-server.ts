import {
  isActionResult,
  isActionSequenceResult,
  isFocusUpdate,
  isSnapshotResponse,
  isSourceQueryResponse,
  PROTOCOL_VERSION,
  WS_PATH,
} from '@agentlensjs/shared';
import type {
  ActionRequest,
  ActionResult,
  ActionSequenceRequest,
  ActionSequenceResult,
  ActionStep,
  AgentLensEvent,
  SnapshotRequest,
  SnapshotResponse,
  SourceQueryRequest,
  SourceQueryResponse,
} from '@agentlensjs/shared';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RawData } from 'ws';
import { WebSocketServer, WebSocket } from 'ws';

import { isAllowedOrigin } from './origin';
import type { StackResolver } from './stack-resolver';
import type { EventStore } from './store';
import { parseEvent } from './validate';

const SNAPSHOT_TIMEOUT_MS = 5000;
// Must exceed the runtime's settle ceiling (5s) so a slow-but-successful
// action reports its result instead of racing the timeout.
const ACTION_TIMEOUT_MS = 10_000;
const BIND_RETRY_DELAY_MS = 500;
const BIND_MAX_RETRIES = 10;

/** An action request minus the envelope fields the server fills in. */
export type ActionCommand = Omit<ActionRequest, 'kind' | 'requestId'>;

/** Live focus/visibility state of one connected browser session. */
export interface SessionFocusInfo {
  sessionId: string;
  /** Null when the runtime has not reported focus state (older runtime). */
  visible: boolean | null;
  focused: boolean | null;
  /**
   * URL from the latest focus report — fresher than the store's per-event
   * URL after SPA route changes that emit no events. Null until reported.
   */
  url: string | null;
}

export interface WsIngestServer {
  /**
   * Focus/visibility state of every currently connected session, so agents
   * can tell which page the user is actually looking at.
   */
  sessionFocus: () => SessionFocusInfo[];
  /**
   * Asks a connected browser session for a structured layout snapshot.
   * Targets the given session when provided, otherwise the most recently
   * active connection. Rejects when no browser is connected or the browser
   * does not answer within the timeout.
   */
  requestSnapshot: (sessionId?: string, timeoutMs?: number) => Promise<SnapshotResponse>;
  /**
   * Asks a connected browser session to perform a page action. The runtime
   * answers with the outcome after the page settles; refusals (actions
   * disabled, user active, bad target) come back as `ok: false` results,
   * not rejections. Rejects only on transport problems: no connected
   * browser or no answer within the timeout.
   */
  requestAction: (
    command: ActionCommand,
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<ActionResult>;
  /**
   * Asks a connected browser session to run several actions in order.
   * The runtime stops at the first failure (or when the user takes over)
   * and reports the break point; same refusal semantics as requestAction.
   */
  requestActionSequence: (
    steps: ActionStep[],
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<ActionSequenceResult>;
  /**
   * Asks a connected browser session which elements a source file renders
   * right now — the reverse direction of source attribution.
   */
  requestSourceQuery: (
    source: string,
    sessionId?: string,
    timeoutMs?: number,
  ) => Promise<SourceQueryResponse>;
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
  /** Null until the runtime sends its first focus-update (older runtimes never do). */
  visible: boolean | null;
  focused: boolean | null;
  lastFocusAt: number;
  /** URL carried by the latest focus-update. */
  url: string | null;
  /** Diagnostics are logged once per connection to avoid stderr storms. */
  warnedVersionMismatch: boolean;
  warnedMalformedEvents: boolean;
}

/**
 * Ranks a connection by how likely it is to be the page in front of the
 * user: focused & visible beats merely visible, which beats connections
 * with unknown focus state (old runtimes), which beats known-background
 * tabs. Ties are broken by recency in pickSocket.
 */
function focusRank(info: ConnectionInfo): number {
  if (info.visible === null) {
    return 1;
  }
  if (!info.visible) {
    return 0;
  }
  return info.focused === true ? 3 : 2;
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
  // Swallow resolver failures: Node treats an unhandled rejection as fatal,
  // and one corrupt source map must not take down the whole daemon. The
  // event simply keeps its raw stack without resolved frames.
  if (event.type === 'error') {
    void resolver
      .resolve(event.stack)
      .then((frames) => {
        event.frames = frames;
      })
      .catch(() => undefined);
  } else if (event.type === 'network') {
    void resolver
      .resolve(event.initiatorStack)
      .then((frames) => {
        event.initiatorFrames = frames;
      })
      .catch(() => undefined);
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

  interface Pending<T> {
    resolve: (value: T) => void;
    /** Kept so close() can settle in-flight requests instead of leaving them hanging. */
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }

  const connections = new Map<WebSocket, ConnectionInfo>();
  const pendingSnapshots = new Map<string, Pending<SnapshotResponse>>();
  const pendingActions = new Map<string, Pending<ActionResult>>();
  const pendingSourceQueries = new Map<string, Pending<SourceQueryResponse>>();
  const pendingSequences = new Map<string, Pending<ActionSequenceResult>>();

  /** Rejects and clears every in-flight request of one kind. */
  function drainPending<T>(pending: Map<string, Pending<T>>): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The AgentLens daemon is shutting down.'));
    }
    pending.clear();
  }

  let wss: WebSocketServer;
  let bindAttempts = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;

  const handleConnection = (socket: WebSocket): void => {
    connections.set(socket, {
      sessionId: null,
      lastActivityAt: Date.now(),
      visible: null,
      focused: null,
      lastFocusAt: 0,
      url: null,
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

      if (isActionResult(message)) {
        const pending = pendingActions.get(message.requestId);
        if (pending) {
          pendingActions.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        return;
      }

      if (isActionSequenceResult(message)) {
        const pending = pendingSequences.get(message.requestId);
        if (pending) {
          pendingSequences.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        return;
      }

      if (isSourceQueryResponse(message)) {
        const pending = pendingSourceQueries.get(message.requestId);
        if (pending) {
          pendingSourceQueries.delete(message.requestId);
          clearTimeout(pending.timer);
          pending.resolve(message);
        }
        return;
      }

      if (isFocusUpdate(message)) {
        const info = connections.get(socket);
        if (info) {
          // Binds the session id early too: focus updates arrive right after
          // connect, before the first event batch.
          info.sessionId = message.sessionId;
          info.visible = message.visible;
          info.focused = message.focused;
          info.url = message.url;
          if (message.focused) {
            info.lastFocusAt = message.at;
          }
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
      // Memory guard at the trust boundary: schema validation caps field
      // *shapes* but not message size. Runtime batches and snapshot
      // responses stay well under this; a hostile page cannot buffer
      // gigabytes into the daemon.
      maxPayload: 5 * 1024 * 1024,
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
    let bestRank = -1;
    let bestRecency = -1;
    for (const [socket, info] of connections) {
      if (socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (sessionId !== undefined && info.sessionId !== sessionId) {
        continue;
      }
      // Prefer the page the user is looking at; among equals (e.g. two
      // focused windows on separate monitors) the most recent one wins.
      const rank = focusRank(info);
      const recency = Math.max(info.lastActivityAt, info.lastFocusAt);
      if (rank > bestRank || (rank === bestRank && recency > bestRecency)) {
        best = socket;
        bestRank = rank;
        bestRecency = recency;
      }
    }
    return best;
  }

  return {
    sessionFocus: () => {
      const states: SessionFocusInfo[] = [];
      for (const [socket, info] of connections) {
        if (socket.readyState === WebSocket.OPEN && info.sessionId !== null) {
          states.push({
            sessionId: info.sessionId,
            visible: info.visible,
            focused: info.focused,
            url: info.url,
          });
        }
      }
      return states;
    },
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
        pendingSnapshots.set(request.requestId, { resolve, reject, timer });
        socket.send(JSON.stringify(request));
      });
    },
    requestAction: (command, sessionId, timeoutMs: number = ACTION_TIMEOUT_MS) => {
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
      const request: ActionRequest = {
        ...command,
        kind: 'action-request',
        requestId: randomUUID(),
      };
      return new Promise<ActionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingActions.delete(request.requestId);
          reject(
            new Error(
              'The browser did not answer the action request in time — the page may have navigated or closed.',
            ),
          );
        }, timeoutMs);
        pendingActions.set(request.requestId, { resolve, reject, timer });
        socket.send(JSON.stringify(request));
      });
    },
    requestActionSequence: (
      steps,
      sessionId,
      // Scaled per step: the single-action default (10s) would time out a
      // perfectly healthy 3-step sequence whose steps each settle slowly.
      timeoutMs: number = Math.min(5000 + steps.length * ACTION_TIMEOUT_MS, 90_000),
    ) => {
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
      const request: ActionSequenceRequest = {
        kind: 'action-sequence-request',
        requestId: randomUUID(),
        steps,
      };
      return new Promise<ActionSequenceResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingSequences.delete(request.requestId);
          reject(
            new Error(
              'The browser did not answer the action sequence in time. Note: there is ' +
                'no cancellation channel — the page may still be executing the remaining ' +
                'steps, so re-check page state before assuming nothing happened.',
            ),
          );
        }, timeoutMs);
        pendingSequences.set(request.requestId, { resolve, reject, timer });
        socket.send(JSON.stringify(request));
      });
    },
    requestSourceQuery: (source, sessionId, timeoutMs: number = SNAPSHOT_TIMEOUT_MS) => {
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
      const request: SourceQueryRequest = {
        kind: 'source-query-request',
        requestId: randomUUID(),
        source,
      };
      return new Promise<SourceQueryResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingSourceQueries.delete(request.requestId);
          reject(new Error('The browser did not answer the source query in time.'));
        }, timeoutMs);
        pendingSourceQueries.set(request.requestId, { resolve, reject, timer });
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
        drainPending(pendingSnapshots);
        drainPending(pendingActions);
        drainPending(pendingSourceQueries);
        drainPending(pendingSequences);
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
