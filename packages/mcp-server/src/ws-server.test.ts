import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type {
  ActionResult,
  ErrorEvent,
  LifecycleEvent,
  SnapshotResponse,
} from '@agentlensjs/shared';
import { PROTOCOL_VERSION, WS_PATH, isActionRequest, isSnapshotRequest } from '@agentlensjs/shared';
import type { StackResolver } from './stack-resolver';
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

function makeActionResult(requestId: string, sessionId: string): ActionResult {
  return {
    kind: 'action-result',
    requestId,
    sessionId,
    ok: true,
    error: null,
    target: { tag: 'button', id: 'go', text: 'Go', source: 'src/App.vue:3' },
    effects: { errors: 1, failedRequests: 0, consoleErrors: 0 },
    settledAfterMs: 120,
    settleTimedOut: false,
  };
}

/** A fake browser runtime: connects, registers a session, answers requests. */
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
    if (isActionRequest(message)) {
      socket.send(JSON.stringify(makeActionResult(message.requestId, sessionId)));
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

describe('ws ingest server actions', () => {
  let server: WsIngestServer | null = null;
  const sockets: WebSocket[] = [];
  const port = 19_631 + Math.floor(Math.random() * 1000);

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
    await expect(server.requestAction({ action: 'click' })).rejects.toThrow('No browser session');
  });

  it('round-trips an action request to the targeted session', async () => {
    server = startWsIngestServer(new EventStore(), port);
    sockets.push(await connectRuntime(port, 'session-a'));
    sockets.push(await connectRuntime(port, 'session-b'));

    const result = await server.requestAction(
      { action: 'click', target: { selector: '#go' } },
      'session-a',
    );
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('session-a');
    expect(result.effects.errors).toBe(1);
    expect(result.target?.source).toBe('src/App.vue:3');

    await expect(server.requestAction({ action: 'click' }, 'session-missing')).rejects.toThrow(
      'session-missing',
    );
  });

  it('times out when the browser never answers an action', async () => {
    server = startWsIngestServer(new EventStore(), port);
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

    await expect(server.requestAction({ action: 'click' }, undefined, 150)).rejects.toThrow(
      'did not answer the action request',
    );
  });
});

describe('ws ingest server security boundary', () => {
  let server: WsIngestServer | null = null;
  const sockets: WebSocket[] = [];
  const port = 17_631 + Math.floor(Math.random() * 1000);
  const wsUrl = `ws://localhost:${String(port)}${WS_PATH}`;

  afterEach(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    sockets.length = 0;
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  async function connectWithOrigin(origin?: string): Promise<'open' | 'rejected'> {
    const socket = new WebSocket(wsUrl, origin === undefined ? {} : { origin });
    sockets.push(socket);
    return new Promise((resolve) => {
      socket.on('open', () => {
        resolve('open');
      });
      socket.on('error', () => {
        resolve('rejected');
      });
    });
  }

  it('accepts local dev origins and originless clients', async () => {
    server = startWsIngestServer(new EventStore(), port);
    await expect(connectWithOrigin(undefined)).resolves.toBe('open');
    await expect(connectWithOrigin('http://localhost:5173')).resolves.toBe('open');
    await expect(connectWithOrigin('http://192.168.1.20:5173')).resolves.toBe('open');
  });

  it('rejects handshakes from public web origins', async () => {
    server = startWsIngestServer(new EventStore(), port);
    await expect(connectWithOrigin('https://evil.example.com')).resolves.toBe('rejected');
    await expect(connectWithOrigin('null')).resolves.toBe('rejected');
  });

  it('accepts origins from the extra allow-list', async () => {
    server = startWsIngestServer(new EventStore(), port, undefined, {
      allowedOrigins: ['https://preview.example.com'],
    });
    await expect(connectWithOrigin('https://preview.example.com')).resolves.toBe('open');
  });

  it('logs (once) and drops batches with a mismatched protocol version', async () => {
    const store = new EventStore();
    server = startWsIngestServer(store, port);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const socket = new WebSocket(wsUrl);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    const staleBatch = JSON.stringify({ protocolVersion: -1, events: [makeLifecycle('s1')] });
    socket.send(staleBatch);
    socket.send(staleBatch);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(store.size).toBe(0);
    const versionWarnings = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes('protocol'),
    );
    expect(versionWarnings).toHaveLength(1);
  });

  it('survives a stack resolver failure and keeps the event', async () => {
    const store = new EventStore();
    // A resolver that rejects (e.g. a corrupt source map) must not surface
    // as an unhandled rejection — that would kill the daemon process.
    const failingResolver = {
      resolve: () => Promise.reject(new Error('corrupt source map')),
    } as unknown as StackResolver;
    server = startWsIngestServer(store, port, failingResolver);

    const socket = new WebSocket(wsUrl);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    const errorEvent: ErrorEvent = {
      id: crypto.randomUUID(),
      type: 'error',
      timestamp: Date.now(),
      sessionId: 's1',
      url: 'http://localhost:5173/',
      subtype: 'uncaught',
      message: 'boom',
      stack: 'Error: boom\n    at fn (http://localhost:5173/src/a.ts:1:1)',
      frames: [],
      occurrences: 1,
    };
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, events: [errorEvent] }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(store.size).toBe(1);
    expect(store.query({ type: 'error' })[0]?.type).toBe('error');
  });

  it('drops malformed events but keeps valid ones from the same batch', async () => {
    const store = new EventStore();
    server = startWsIngestServer(store, port);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const socket = new WebSocket(wsUrl);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    socket.send(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        events: [
          // Shallow-valid but missing the whole error payload.
          { id: 'x', timestamp: 1, sessionId: 's1', url: 'http://localhost/', type: 'error' },
          makeLifecycle('s1'),
        ],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(store.size).toBe(1);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes('malformed'))).toBe(true);
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
