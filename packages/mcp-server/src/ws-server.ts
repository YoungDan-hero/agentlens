import { isAgentLensEvent, PROTOCOL_VERSION, WS_PATH } from '@agentlens/shared';
import type { ProtocolMessage } from '@agentlens/shared';
import { WebSocketServer } from 'ws';

import type { EventStore } from './store';

export interface WsIngestServer {
  close: () => Promise<void>;
}

/**
 * Accepts WebSocket connections from `@agentlens/runtime` instances and
 * ingests their event batches into the store.
 */
export function startWsIngestServer(store: EventStore, port: number): WsIngestServer {
  const wss = new WebSocketServer({ port, path: WS_PATH });

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
