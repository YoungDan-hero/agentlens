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

function makeNetwork(status: number | null, overrides: Partial<NetworkEvent> = {}): NetworkEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'network',
    transport: 'fetch',
    timestamp: Date.now(),
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    method: 'GET',
    requestUrl: '/api/data',
    status,
    durationMs: 12,
    initiatorStack: null,
    initiatorFrames: [],
    requestBody: null,
    responseBody: null,
    ...overrides,
  };
}

describe('EventStore', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new EventStore(0)).toThrow(RangeError);
  });

  it('caps the session index and evicts the least recently active session', () => {
    const store = new EventStore();
    const base = Date.now();
    // 101 page loads: one session each. The oldest must give way.
    for (let i = 0; i < 101; i += 1) {
      store.add(
        makeError({
          sessionId: `session-${String(i)}`,
          timestamp: base + i,
          message: `m${String(i)}`,
        }),
      );
    }

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(100);
    expect(sessions.some((s) => s.sessionId === 'session-0')).toBe(false);
    expect(sessions.some((s) => s.sessionId === 'session-100')).toBe(true);
  });

  it('reports the latest code update after a baseline, scoped by origin', () => {
    const store = new EventStore();
    const base = Date.now();
    const lifecycle = (timestamp: number, url: string): AgentLensEvent => {
      counter += 1;
      return {
        id: `event-${String(counter)}`,
        type: 'lifecycle',
        timestamp,
        sessionId: 's1',
        url,
        phase: 'hmr-update',
      };
    };
    store.add(lifecycle(base + 100, 'http://localhost:5173/'));
    store.add(lifecycle(base + 200, 'http://localhost:5173/#/settings'));
    store.add(lifecycle(base + 300, 'http://localhost:4000/')); // other dev server

    // Latest matching update wins; the foreign origin never counts.
    expect(store.latestCodeUpdateSince(base, 'http://localhost:5173')).toBe(base + 200);
    // Strictly after the baseline.
    expect(store.latestCodeUpdateSince(base + 200, 'http://localhost:5173')).toBeNull();
    // Unscoped sees everything.
    expect(store.latestCodeUpdateSince(base)).toBe(base + 300);
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

  it('filters events by source attribution across event kinds', () => {
    const store = new EventStore();
    const interaction: AgentLensEvent = {
      id: 'i1',
      type: 'interaction',
      subtype: 'click',
      timestamp: Date.now(),
      sessionId: 'session-1',
      url: 'http://localhost:5173/',
      target: { tag: 'button', id: 'go', text: 'Go', source: 'src/App.vue:12' },
    };
    store.add(interaction);
    // Resolved frame paths carry a leading slash; the filter must still match.
    store.add(
      makeError({
        message: 'from App',
        frames: [{ functionName: 'render', fileName: '/src/App.vue', line: 30, column: 5 }],
      }),
    );
    store.add(
      makeNetwork(500, {
        initiatorFrames: [{ functionName: 'load', fileName: '/src/api.ts', line: 8, column: 1 }],
      }),
    );
    store.add(makeError({ message: 'unattributed' }));

    const byFile = store.query({ source: 'src/App.vue' });
    expect(byFile.map((event) => event.type).sort()).toEqual(['error', 'interaction']);

    // Exact line narrows within the file.
    expect(store.query({ source: 'src/App.vue:12' })).toHaveLength(1);
    expect(store.query({ source: 'src/App.vue:12' })[0]?.type).toBe('interaction');

    expect(store.query({ source: 'src/api.ts' })[0]?.type).toBe('network');
    expect(store.query({ source: 'src/Missing.vue' })).toHaveLength(0);
  });

  it('matches absolute resolved frame paths against relative source filters', () => {
    const store = new EventStore();
    store.add(
      makeError({
        frames: [
          {
            functionName: 'onClick',
            fileName: '/Users/dev/project/examples/vue-demo/src/App.vue',
            line: 79,
            column: 3,
          },
        ],
      }),
    );

    expect(store.query({ source: 'src/App.vue' })).toHaveLength(1);
    expect(store.query({ source: 'src/App.vue:79' })).toHaveLength(1);
    // Boundary check: `App.vue` as a bare suffix must not match `NotApp.vue`.
    expect(store.query({ source: 'pp.vue' })).toHaveLength(0);
  });

  it('matches basename-only frame paths (Vue SFC sourcemaps)', () => {
    const store = new EventStore();
    // @vitejs/plugin-vue emits `App.vue` as the source, with no directory.
    store.add(
      makeError({
        frames: [{ functionName: 'onClick', fileName: 'App.vue', line: 79, column: 3 }],
      }),
    );

    expect(store.query({ source: 'src/App.vue' })).toHaveLength(1);
    expect(store.query({ source: 'src/App.vue:79' })).toHaveLength(1);
    expect(store.query({ source: 'src/Other.vue' })).toHaveLength(0);
  });

  it('applies the same tolerant path matching to interaction attributions', () => {
    const store = new EventStore();
    const interaction: AgentLensEvent = {
      id: 'i-path',
      type: 'interaction',
      subtype: 'click',
      timestamp: Date.now(),
      sessionId: 'session-1',
      url: 'http://localhost:5173/',
      target: { tag: 'button', id: null, text: 'Go', source: 'src/App.vue:12' },
    };
    store.add(interaction);

    // A basename filter must behave the same for interactions as for
    // stack frames — `App.vue` matches `src/App.vue:12`.
    expect(store.query({ source: 'App.vue' })).toHaveLength(1);
    expect(store.query({ source: 'App.vue:12' })).toHaveLength(1);
    expect(store.query({ source: 'App.vue:99' })).toHaveLength(0);
    // Suffix matching stays anchored at directory boundaries.
    expect(store.query({ source: 'pp.vue' })).toHaveLength(0);
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

  it('surfaces a recurring folded error at the newest query position', () => {
    const store = new EventStore();
    const stack = 'Error: boom\n    at render (App.tsx:1:1)';
    const now = Date.now();
    const error = store.add(makeError({ stack, timestamp: now - 1000 }));
    // Newer unrelated events would bury the error at its original slot.
    store.add(makeNetwork(200, { timestamp: now - 500 }));
    store.add(makeNetwork(201, { timestamp: now - 400 }));
    // The recurrence must pull the canonical record back to the front.
    store.add(makeError({ stack, timestamp: now }));

    const latest = store.query({ limit: 2 });
    expect(latest[0]?.id).toBe(error.id);
    expect(store.size).toBe(3);
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

  it('does not count fire-and-forget beacons as failed requests', () => {
    const store = new EventStore();
    store.add(makeNetwork(null, { transport: 'beacon', method: 'POST' }));
    store.add(makeNetwork(null, { transport: 'websocket', method: 'WS' }));

    expect(store.summarize(60_000).failedRequestCount).toBe(1);
  });

  it('clears all events', () => {
    const store = new EventStore();
    store.add(makeError());
    store.clear();
    expect(store.size).toBe(0);
    expect(store.query()).toEqual([]);
  });
});
