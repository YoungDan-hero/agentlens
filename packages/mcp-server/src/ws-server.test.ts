import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { LifecycleEvent, SnapshotResponse } from '@agentlensjs/shared';
import { PROTOCOL_VERSION, WS_PATH, isSnapshotRequest } from '@agentlensjs/shared';
import { EventStore } from './store';
import { startWsIngestServer, type WsIngestServer } from './ws-server';

function makeLifecycle(sessionId: string): LifecycleEvent {
  return {
    id: crypto.randomUUID(),
    type: 'lifecycle',
    timestamp: Date.now(),
    sessionId,
    url: 'http://localhost:5173/',
    phase: 'load',
  };
}

function makeSnapshotResponse(requestId: string, sessionId: string): SnapshotResponse {
  return {
    kind: 'snapshot-response',
    requestId,
    sessionId,
    url: 'http://localhost:5173/',
    capturedAt: Date.now(),
    root: {
      tag: 'body',
      source: null,
      rect: { x: 0, y: 0, width: 800, height: 600 },
      visible: true,
      overflow: false,
      text: null,
      children: [],
    },
    truncated: false,
  };
}

/** A fake browser runtime: connects, registers a session, answers snapshots. */
async function connectRuntime(port: number, sessionId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://localhost:${String(port)}${WS_PATH}`);
  await new Promise<void>((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  socket.on('message', (raw) => {
    const message: unknown = JSON.parse((raw as Buffer).toString('utf8'));
    if (isSnapshotRequest(message)) {
      socket.send(JSON.stringify(makeSnapshotResponse(message.requestId, sessionId)));
    }
  });
  socket.send(
    JSON.stringify({ protocolVersion: PROTOCOL_VERSION, events: [makeLifecycle(sessionId)] }),
  );
  // Give the server a beat to ingest the registration batch.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return socket;
}

describe('ws ingest server snapshots', () => {
  let server: WsIngestServer | null = null;
  const sockets: WebSocket[] = [];
  const port = 18_631 + Math.floor(Math.random() * 1000);

  afterEach(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    sockets.length = 0;
    await server?.close();
    server = null;
  });

  it('rejects when no browser is connected', async () => {
    server = startWsIngestServer(new EventStore(), port);
    await expect(server.requestSnapshot()).rejects.toThrow('No browser session');
  });

  it('round-trips a snapshot request to the connected runtime', async () => {
    const store = new EventStore();
    server = startWsIngestServer(store, port);
    sockets.push(await connectRuntime(port, 'session-a'));

    const response = await server.requestSnapshot();
    expect(response.sessionId).toBe('session-a');
    expect(response.root?.tag).toBe('body');
    expect(store.size).toBe(1);
  });

  it('targets the requested session and rejects unknown ones', async () => {
    server = startWsIngestServer(new EventStore(), port);
    sockets.push(await connectRuntime(port, 'session-a'));
    sockets.push(await connectRuntime(port, 'session-b'));

    const response = await server.requestSnapshot('session-b');
    expect(response.sessionId).toBe('session-b');

    await expect(server.requestSnapshot('session-missing')).rejects.toThrow('session-missing');
  });

  it('times out when the browser never answers', async () => {
    server = startWsIngestServer(new EventStore(), port);
    // A runtime that registers but ignores snapshot requests.
    const socket = new WebSocket(`ws://localhost:${String(port)}${WS_PATH}`);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    socket.send(
      JSON.stringify({ protocolVersion: PROTOCOL_VERSION, events: [makeLifecycle('s')] }),
    );
    sockets.push(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(server.requestSnapshot(undefined, 150)).rejects.toThrow('did not answer');
  });
});

describe('ws ingest server port binding', () => {
  let server: WsIngestServer | null = null;
  let blocker: WsIngestServer | null = null;
  const port = 19_631 + Math.floor(Math.random() * 1000);

  afterEach(async () => {
    await server?.close();
    server = null;
    await blocker?.close();
    blocker = null;
  });

  it('retries binding until the previous holder releases the port', async () => {
    blocker = startWsIngestServer(new EventStore(), port);
    // Let the blocker finish binding before spawning the contender.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const store = new EventStore();
    server = startWsIngestServer(store, port, undefined, {
      bindRetryDelayMs: 50,
      bindMaxRetries: 20,
      onFatal: () => {
        throw new Error('onFatal must not fire when the port frees up');
      },
    });

    // Simulates the MCP reload race: the old daemon shuts down shortly
    // after the new one starts colliding on the port.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await blocker.close();
    blocker = null;

    // The retry loop should eventually bind and accept runtime traffic.
    let socket: WebSocket | null = null;
    for (let attempt = 0; attempt < 40 && socket === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        socket = await connectRuntime(port, 'session-retry');
      } catch {
        socket = null;
      }
    }
    expect(socket).not.toBeNull();
    expect(store.size).toBe(1);
    socket?.close();
  });

  it('reports a fatal error once bind retries are exhausted', async () => {
    blocker = startWsIngestServer(new EventStore(), port);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fatal = new Promise<number>((resolve) => {
      server = startWsIngestServer(new EventStore(), port, undefined, {
        bindRetryDelayMs: 20,
        bindMaxRetries: 2,
        onFatal: resolve,
      });
    });

    await expect(fatal).resolves.toBe(1);
  });
});
