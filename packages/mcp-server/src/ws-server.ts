import { isAgentLensEvent, PROTOCOL_VERSION, WS_PATH } from '@agentlens/shared';
import type { AgentLensEvent, ProtocolMessage } from '@agentlens/shared';
import { WebSocketServer } from 'ws';

import type { StackResolver } from './stack-resolver';
import type { EventStore } from './store';

export interface WsIngestServer {
  close: () => Promise<void>;
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
 * Accepts WebSocket connections from `@agentlens/runtime` instances and
 * ingests their event batches into the store.
 */
export function startWsIngestServer(
  store: EventStore,
  port: number,
  resolver?: StackResolver,
): WsIngestServer {
  const wss = new WebSocketServer({ port, path: WS_PATH });

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
    socket.on('message', (raw) => {
      let message: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isProtocolMessage(message)) {
        return;
      }
      for (const event of message.events) {
        store.add(event);
        if (resolver) {
          resolveStacks(event, resolver);
        }
      }
    });
  });

  return {
    close: () =>
      new Promise((resolve, reject) => {
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
