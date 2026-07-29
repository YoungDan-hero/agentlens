import { describe, expect, it } from 'vitest';

import type { AgentLensEvent, ErrorEvent, NetworkEvent } from '@agentlensjs/shared';
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
    occurrences: 1,
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
    // Distinct messages so folding does not interfere with eviction.
    const [first, second, third] = [
      makeError({ message: 'one' }),
      makeError({ message: 'two' }),
      makeError({ message: 'three' }),
    ];
    for (const event of [first, second, third]) {
      store.add(event);
    }

    expect(store.size).toBe(2);
    const ids = store.query({ limit: 10 }).map((event: AgentLensEvent) => event.id);
    expect(ids).toEqual([third.id, second.id]);
  });

  it('folds identical errors into one record with an occurrence count', () => {
    const store = new EventStore();
    const first = makeError({ stack: 'Error: boom\n    at render (App.tsx:1:1)' });
    const firstSeenAt = first.timestamp;
    const stored1 = store.add(first);
    const stored2 = store.add(
      makeError({
        stack: 'Error: boom\n    at render (App.tsx:1:1)',
        timestamp: firstSeenAt + 50,
      }),
    );

    expect(stored1).toBe(first);
    expect(stored2).toBe(first);
    expect(store.size).toBe(1);
    expect(first.occurrences).toBe(2);
    // The canonical record carries its fingerprint and is retrievable by it.
    expect(first.fingerprint).toBeTruthy();
    expect(store.getErrorByFingerprint(first.fingerprint ?? '')).toBe(first);
    // The folded record surfaces the latest occurrence time.
    expect(first.timestamp).toBe(firstSeenAt + 50);
  });

  it('reassigns a folded error to the session of its latest occurrence', () => {
    const store = new EventStore();
    const stack = 'Error: boom\n    at render (App.tsx:1:1)';
    const now = Date.now();
    store.add(makeError({ stack, sessionId: 'before-reload', timestamp: now - 1000 }));
    store.add(makeError({ stack, sessionId: 'after-reload', timestamp: now }));

    // A reload must not hide a still-recurring error from the new session.
    const summary = store.summarize(60_000);
    expect(summary.sessionId).toBe('after-reload');
    expect(summary.errorCount).toBe(1);
    expect(summary.errorOccurrences).toBe(2);
  });

  it('does not fold errors thrown from different locations', () => {
    const store = new EventStore();
    store.add(makeError({ stack: 'Error: boom\n    at a (A.tsx:1:1)' }));
    store.add(makeError({ stack: 'Error: boom\n    at b (B.tsx:2:2)' }));

    expect(store.size).toBe(2);
  });

  it('tracks sessions and filters queries by sessionId', () => {
    const store = new EventStore();
    store.add(makeError({ message: 'one', sessionId: 'tab-1' }));
    store.add(makeError({ message: 'two', sessionId: 'tab-2' }));

    expect(store.listSessions().map((s) => s.sessionId)).toContain('tab-1');
    const tab2Events = store.query({ sessionId: 'tab-2' });
    expect(tab2Events).toHaveLength(1);
    expect(tab2Events[0]?.type === 'error' && tab2Events[0].message).toBe('two');
  });

  it('scopes the summary to the most recently active session by default', () => {
    const store = new EventStore();
    const now = Date.now();
    store.add(makeError({ message: 'old tab', sessionId: 'tab-1', timestamp: now - 1000 }));
    store.add(makeError({ message: 'new tab', sessionId: 'tab-2', timestamp: now }));

    const summary = store.summarize(60_000);
    expect(summary.sessionId).toBe('tab-2');
    expect(summary.sessionCount).toBe(2);
    expect(summary.errorCount).toBe(1);
  });

  it('counts folded occurrences separately from distinct errors', () => {
    const store = new EventStore();
    const stack = 'Error: storm\n    at loop (App.tsx:9:9)';
    store.add(makeError({ message: 'storm', stack }));
    store.add(makeError({ message: 'storm', stack }));
    store.add(makeError({ message: 'storm', stack }));

    const summary = store.summarize(60_000);
    expect(summary.errorCount).toBe(1);
    expect(summary.errorOccurrences).toBe(3);
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
