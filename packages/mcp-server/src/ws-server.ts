import {
  isAgentLensEvent,
  isSnapshotResponse,
  PROTOCOL_VERSION,
  WS_PATH,
} from '@agentlensjs/shared';
import type {
  AgentLensEvent,
  ProtocolMessage,
  SnapshotRequest,
  SnapshotResponse,
} from '@agentlensjs/shared';
import { randomUUID } from 'node:crypto';
import type { RawData } from 'ws';
import { WebSocketServer, WebSocket } from 'ws';

import type { StackResolver } from './stack-resolver';
import type { EventStore } from './store';

const SNAPSHOT_TIMEOUT_MS = 5000;

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

interface ConnectionInfo {
  sessionId: string | null;
  lastActivityAt: number;
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
): WsIngestServer {
  // Loopback only: events arrive unauthenticated, so the ingest endpoint
  // must never be reachable from other machines on the network.
  const wss = new WebSocketServer({ host: '127.0.0.1', port, path: WS_PATH });
  const connections = new Map<WebSocket, ConnectionInfo>();
  const pendingSnapshots = new Map<
    string,
    { resolve: (response: SnapshotResponse) => void; timer: NodeJS.Timeout }
  >();

  wss.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[agentlens] port ${String(port)} is already in use — ` +
          'is another AgentLens daemon running? Stop it or set AGENTLENS_PORT.',
      );
    } else {
      console.error('[agentlens] ingest server error:', error);
    }
    process.exit(1);
  });

  wss.on('connection', (socket) => {
    connections.set(socket, { sessionId: null, lastActivityAt: Date.now() });

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

      if (!isProtocolMessage(message)) {
        return;
      }
      const info = connections.get(socket);
      if (info) {
        info.lastActivityAt = Date.now();
        info.sessionId = message.events[0]?.sessionId ?? info.sessionId;
      }
      for (const event of message.events) {
        const stored = store.add(event);
        // Folded duplicates reuse the canonical record's resolved frames.
        if (resolver && stored === event) {
          resolveStacks(event, resolver);
        }
      }
    });
  });

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
        for (const pending of pendingSnapshots.values()) {
          clearTimeout(pending.timer);
        }
        pendingSnapshots.clear();
        for (const socket of connections.keys()) {
          socket.close();
        }
        wss.close((error) => {
          if (error) {
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

function isProtocolMessage(value: unknown): value is ProtocolMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ProtocolMessage>;
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    Array.isArray(candidate.events) &&
    candidate.events.every(isAgentLensEvent)
  );
}
