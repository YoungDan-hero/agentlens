import { describe, expect, it } from 'vitest';

import type { AgentLensEvent, ErrorEvent, NetworkEvent } from '@agentlens/shared';
import { EventStore } from './store';

let counter = 0;

function makeError(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'error',
    subtype: 'uncaught',
    timestamp: Date.now(),
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    message: 'boom',
    stack: null,
    frames: [],
    ...overrides,
  };
}

function makeNetwork(status: number | null): NetworkEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'network',
    timestamp: Date.now(),
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    method: 'GET',
    requestUrl: '/api/data',
    status,
    durationMs: 12,
    initiatorStack: null,
    initiatorFrames: [],
  };
}

describe('EventStore', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new EventStore(0)).toThrow(RangeError);
  });

  it('evicts oldest events beyond capacity', () => {
    const store = new EventStore(2);
    const [first, second, third] = [makeError(), makeError(), makeError()];
    for (const event of [first, second, third]) {
      store.add(event);
    }

    expect(store.size).toBe(2);
    const ids = store.query({ limit: 10 }).map((event: AgentLensEvent) => event.id);
    expect(ids).toEqual([third.id, second.id]);
  });

  it('filters by type and respects the limit, newest first', () => {
    const store = new EventStore();
    store.add(makeNetwork(200));
    const error = makeError();
    store.add(error);
    store.add(makeNetwork(500));

    const errors = store.query({ type: 'error' });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe(error.id);

    expect(store.query({ limit: 2 })).toHaveLength(2);
  });

  it('filters by sinceMs', () => {
    const store = new EventStore();
    store.add(makeError({ timestamp: 1000 }));
    store.add(makeError({ timestamp: 2000 }));

    const recent = store.query({ sinceMs: 1500 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.timestamp).toBe(2000);
  });

  it('summarizes errors and failed requests within the window', () => {
    const store = new EventStore();
    store.add(makeError());
    store.add(makeNetwork(200));
    store.add(makeNetwork(500));
    store.add(makeNetwork(null));

    const summary = store.summarize(60_000);
    expect(summary.totalEvents).toBe(4);
    expect(summary.errorCount).toBe(1);
    expect(summary.failedRequestCount).toBe(2);
    expect(summary.lastEventAt).not.toBeNull();
  });

  it('clears all events', () => {
    const store = new EventStore();
    store.add(makeError());
    store.clear();
    expect(store.size).toBe(0);
    expect(store.query()).toEqual([]);
  });
});
