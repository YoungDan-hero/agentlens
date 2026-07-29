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
});
