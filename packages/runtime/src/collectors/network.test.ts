import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentLensEvent, NetworkEvent } from '@agentlensjs/shared';
import type { EventContext } from '../events';
import type { EventSink } from '../transport';
import { installNetworkCollector } from './network';

const context: EventContext = {
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
};

function createSink(): { sink: EventSink; events: AgentLensEvent[] } {
  const events: AgentLensEvent[] = [];
  return {
    sink: {
      send: (event) => {
        events.push(event);
      },
    },
    events,
  };
}

function lastNetworkEvent(events: AgentLensEvent[]): NetworkEvent {
  const event = events.at(-1);
  if (event?.type !== 'network') {
    throw new Error('expected a network event');
  }
  return event;
}

describe('installNetworkCollector', () => {
  const originalFetch = globalThis.fetch;
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    globalThis.fetch = originalFetch;
  });

  it('records status and duration for successful requests', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('ok', { status: 201 }));
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const response = await fetch('/api/items', { method: 'POST' });

    expect(response.status).toBe(201);
    const event = lastNetworkEvent(events);
    expect(event.method).toBe('POST');
    expect(event.requestUrl).toBe('/api/items');
    expect(event.status).toBe(201);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.initiatorStack).toBeTypeOf('string');
  });

  it('records a null status and rethrows on transport failure', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    await expect(fetch('http://unreachable.invalid/')).rejects.toThrow('Failed to fetch');

    const event = lastNetworkEvent(events);
    expect(event.status).toBeNull();
    expect(event.requestUrl).toBe('http://unreachable.invalid/');
  });

  it('resolves method and url from Request objects', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    await fetch(new Request('http://localhost/api/users', { method: 'delete' }));

    const event = lastNetworkEvent(events);
    expect(event.method).toBe('DELETE');
    expect(event.requestUrl).toBe('http://localhost/api/users');
  });

  it('restores the original fetch after teardown', () => {
    const mocked = globalThis.fetch;
    const { sink } = createSink();
    teardown = installNetworkCollector(sink, context);
    expect(globalThis.fetch).not.toBe(mocked);

    teardown();
    teardown = undefined;
    expect(globalThis.fetch).toBe(mocked);
  });

  it('tags fetch events with their transport and redacts query parameters', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('ok', { status: 200 }));
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    await fetch('/api/items?page=1&apiKey=s3cret');

    const event = lastNetworkEvent(events);
    expect(event.transport).toBe('fetch');
    expect(event.requestUrl).toContain('page=1');
    expect(event.requestUrl).not.toContain('s3cret');
  });

  it('does not capture bodies unless opted in', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('{"data":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    await fetch('/api/items', { method: 'POST', body: '{"password":"x"}' });

    const event = lastNetworkEvent(events);
    expect(event.requestBody).toBeNull();
    expect(event.responseBody).toBeNull();
  });

  it('captures redacted request and response bodies when opted in', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('{"user":"dan","accessToken":"abc"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, { captureBodies: true });

    await fetch('/api/login', { method: 'POST', body: '{"user":"dan","password":"hunter2"}' });
    // The response clone is drained asynchronously before the event ships.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = lastNetworkEvent(events);
    expect(event.requestBody).toContain('"user":"dan"');
    expect(event.requestBody).not.toContain('hunter2');
    expect(event.responseBody).toContain('"user":"dan"');
    expect(event.responseBody).not.toContain('abc');
  });

  it('skips non-textual response bodies even when opted in', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    );
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, { captureBodies: true });

    await fetch('/api/blob');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lastNetworkEvent(events).responseBody).toBeNull();
  });

  it('never drains server-sent event streams', async () => {
    // An SSE body never ends; draining it would hang the event and buffer
    // the stream forever. The response must ship promptly with a null body.
    const endlessStream = new ReadableStream<Uint8Array>({ start: () => undefined });
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(endlessStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, { captureBodies: true });

    await fetch('/api/live');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = lastNetworkEvent(events);
    expect(event.status).toBe(200);
    expect(event.responseBody).toBeNull();
  });

  it('skips oversized bodies via content-length instead of reading them', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response('irrelevant', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '1000000' },
      }),
    );
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, { captureBodies: true });

    await fetch('/api/huge');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(lastNetworkEvent(events).responseBody).toBe('[body omitted: 1000000 bytes]');
  });
});

/** Minimal XHR double; a fresh class per test keeps prototype patches isolated. */
function makeFakeXhrClass() {
  return class FakeXhr {
    status = 0;
    opened = false;
    sent = false;
    responseType = '';
    responseText = '';
    private readonly listeners: (() => void)[] = [];

    open(_method: string, _url: string | URL): void {
      this.opened = true;
    }

    send(_body?: unknown): void {
      this.sent = true;
    }

    addEventListener(_type: string, listener: () => void): void {
      this.listeners.push(listener);
    }

    /** Simulates the request settling; fires the `loadend` listeners. */
    complete(status: number, responseText = ''): void {
      this.status = status;
      this.responseText = responseText;
      for (const listener of this.listeners) {
        listener();
      }
    }
  };
}

describe('installNetworkCollector (XMLHttpRequest)', () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    vi.unstubAllGlobals();
  });

  it('records method, url and status for XHR requests (axios-style)', () => {
    const FakeXhr = makeFakeXhrClass();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const xhr = new FakeXhr();
    xhr.open('post', '/api/xhr-items');
    xhr.send();
    // The wrapper must delegate to the original methods.
    expect(xhr.opened).toBe(true);
    expect(xhr.sent).toBe(true);
    expect(events).toHaveLength(0);

    xhr.complete(404);

    const event = lastNetworkEvent(events);
    expect(event.method).toBe('POST');
    expect(event.requestUrl).toBe('/api/xhr-items');
    expect(event.status).toBe(404);
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    expect(event.initiatorStack).toBeTypeOf('string');
  });

  it('reports a null status when the XHR never got an HTTP response', () => {
    const FakeXhr = makeFakeXhrClass();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const xhr = new FakeXhr();
    xhr.open('GET', new URL('http://127.0.0.1:9/unreachable'));
    xhr.send();
    xhr.complete(0);

    const event = lastNetworkEvent(events);
    expect(event.status).toBeNull();
    expect(event.requestUrl).toBe('http://127.0.0.1:9/unreachable');
  });

  it('does not duplicate events when send is called twice without re-open', () => {
    const FakeXhr = makeFakeXhrClass();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const xhr = new FakeXhr();
    xhr.open('GET', '/api/once');
    xhr.send();
    xhr.send();
    xhr.complete(200);

    expect(events).toHaveLength(1);
  });

  it('restores the XHR prototype methods after teardown', () => {
    const FakeXhr = makeFakeXhrClass();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { sink, events } = createSink();
    const originalOpen = FakeXhr.prototype.open;
    teardown = installNetworkCollector(sink, context);
    expect(FakeXhr.prototype.open).not.toBe(originalOpen);

    teardown();
    teardown = undefined;
    expect(FakeXhr.prototype.open).toBe(originalOpen);

    const xhr = new FakeXhr();
    xhr.open('GET', '/api/after-teardown');
    xhr.send();
    xhr.complete(200);
    expect(events).toHaveLength(0);
  });

  it('captures redacted XHR bodies when opted in', () => {
    const FakeXhr = makeFakeXhrClass();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, { captureBodies: true });

    const xhr = new FakeXhr();
    xhr.open('POST', '/api/login');
    xhr.send('{"user":"dan","password":"hunter2"}');
    xhr.complete(200, '{"sessionToken":"abc"}');

    const event = lastNetworkEvent(events);
    expect(event.transport).toBe('xhr');
    expect(event.requestBody).toContain('"user":"dan"');
    expect(event.requestBody).not.toContain('hunter2');
    expect(event.responseBody).not.toContain('abc');
  });
});

/** Minimal WebSocket double with manual event dispatch. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = url instanceof URL ? url.href : url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

describe('installNetworkCollector (WebSocket)', () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    vi.unstubAllGlobals();
  });

  it('reports an opened connection as a 101 network event', () => {
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const socket = new WebSocket('ws://localhost:9999/live') as unknown as FakeWebSocket;
    expect(events).toHaveLength(0);
    socket.dispatch('open');

    const event = lastNetworkEvent(events);
    expect(event.transport).toBe('websocket');
    expect(event.method).toBe('WS');
    expect(event.requestUrl).toBe('ws://localhost:9999/live');
    expect(event.status).toBe(101);
  });

  it('reports a close before open as a failed connection, exactly once', () => {
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const socket = new WebSocket('ws://localhost:9999/dead') as unknown as FakeWebSocket;
    socket.dispatch('close');
    socket.dispatch('close');

    expect(events).toHaveLength(1);
    expect(lastNetworkEvent(events).status).toBeNull();
  });

  it('never observes the runtime own daemon connection', () => {
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, {
      ignoreWebSocketUrls: ['ws://localhost:8631/agentlens'],
    });

    const socket = new WebSocket('ws://localhost:8631/agentlens') as unknown as FakeWebSocket;
    socket.dispatch('open');

    expect(events).toHaveLength(0);
  });

  it('restores the WebSocket constructor after teardown', () => {
    const { sink } = createSink();
    teardown = installNetworkCollector(sink, context);
    expect(globalThis.WebSocket).not.toBe(FakeWebSocket);

    teardown();
    teardown = undefined;
    expect(globalThis.WebSocket).toBe(FakeWebSocket as unknown as typeof WebSocket);
  });
});

describe('installNetworkCollector (sendBeacon)', () => {
  let teardown: (() => void) | undefined;
  let beaconSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    beaconSpy = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: beaconSpy,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    delete (navigator as Partial<Navigator>).sendBeacon;
    vi.unstubAllGlobals();
  });

  it('records beacon calls and delegates to the original', () => {
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context);

    const queued = navigator.sendBeacon('/analytics?token=abc', 'payload');

    expect(queued).toBe(true);
    expect(beaconSpy).toHaveBeenCalledOnce();
    const event = lastNetworkEvent(events);
    expect(event.transport).toBe('beacon');
    expect(event.method).toBe('POST');
    expect(event.requestUrl).not.toContain('abc');
    expect(event.status).toBeNull();
    expect(event.requestBody).toBeNull();
  });

  it('captures the beacon body only when opted in', () => {
    const { sink, events } = createSink();
    teardown = installNetworkCollector(sink, context, { captureBodies: true });

    navigator.sendBeacon('/analytics', '{"password":"x","step":1}');

    const event = lastNetworkEvent(events);
    expect(event.requestBody).toContain('"step":1');
    expect(event.requestBody).not.toContain('"x"');
  });

  it('restores sendBeacon after teardown', () => {
    const { sink } = createSink();
    teardown = installNetworkCollector(sink, context);
    expect(navigator.sendBeacon).not.toBe(beaconSpy);

    teardown();
    teardown = undefined;
    expect(navigator.sendBeacon).toBe(beaconSpy);
  });
});
