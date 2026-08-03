import type {
  ConsoleEvent,
  ErrorEvent,
  InteractionEvent,
  NetworkEvent,
  PerformanceEvent,
} from '@agentlensjs/shared';
import { describe, expect, it } from 'vitest';

import { buildErrorContext } from './error-context';
import type { ErrorContext } from './error-context';
import { EventStore } from './store';

let counter = 0;
const SESSION = 'session-1';
const BASE = 1_000_000;

function nextId(): string {
  counter += 1;
  return `event-${String(counter)}`;
}

function makeError(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    id: nextId(),
    type: 'error',
    subtype: 'uncaught',
    timestamp: BASE,
    sessionId: SESSION,
    url: 'http://localhost:5173/',
    message: 'boom',
    stack: null,
    frames: [],
    occurrences: 1,
    ...overrides,
  };
}

function makeInteraction(timestamp: number, sessionId = SESSION): InteractionEvent {
  return {
    id: nextId(),
    type: 'interaction',
    subtype: 'click',
    timestamp,
    sessionId,
    url: 'http://localhost:5173/',
    target: { tag: 'button', id: 'save', text: 'Save', source: 'src/App.vue:10' },
  };
}

function makeNetwork(timestamp: number, status = 500): NetworkEvent {
  return {
    id: nextId(),
    type: 'network',
    timestamp,
    sessionId: SESSION,
    url: 'http://localhost:5173/',
    transport: 'fetch',
    method: 'GET',
    requestUrl: 'http://localhost:5173/api/orders',
    status,
    durationMs: 12,
    initiatorStack: null,
    initiatorFrames: [],
    requestBody: null,
    responseBody: null,
  };
}

function makeConsole(timestamp: number, level: ConsoleEvent['level']): ConsoleEvent {
  return {
    id: nextId(),
    type: 'console',
    timestamp,
    sessionId: SESSION,
    url: 'http://localhost:5173/',
    level,
    args: ['warned'],
  };
}

function makePerformance(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
  return {
    id: nextId(),
    type: 'performance',
    timestamp: BASE,
    sessionId: SESSION,
    url: 'http://localhost:5173/',
    metric: 'LCP',
    value: 1200,
    rating: 'good',
    detail: null,
    ...overrides,
  };
}

function expectContext(result: ReturnType<typeof buildErrorContext>): ErrorContext {
  if (typeof result.error === 'string') {
    throw new Error(`expected a context, got failure: ${result.error}`);
  }
  return result as ErrorContext;
}

describe('buildErrorContext', () => {
  it('resolves by fingerprint and gathers windowed signals oldest first', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE - 5000));
    store.add(makeInteraction(BASE - 200));
    store.add(makeNetwork(BASE - 100));
    store.add(makeConsole(BASE - 50, 'warn'));
    const stored = store.add(makeError()) as ErrorEvent;

    const context = expectContext(
      buildErrorContext(store, { fingerprint: stored.fingerprint ?? '' }),
    );

    expect(context.error.id).toBe(stored.id);
    expect(context.session?.sessionId).toBe(SESSION);
    expect(context.precedingInteractions.map((e) => e.timestamp)).toEqual([
      BASE - 5000,
      BASE - 200,
    ]);
    expect(context.relatedNetwork).toHaveLength(1);
    expect(context.relatedConsole).toHaveLength(1);
    expect(context.lookbackMs).toBe(15_000);
  });

  it('resolves by errorId and falls back to the latest error without a ref', () => {
    const store = new EventStore();
    const first = store.add(makeError({ message: 'first' })) as ErrorEvent;
    const second = store.add(
      makeError({ message: 'second', timestamp: BASE + 1000 }),
    ) as ErrorEvent;

    expect(expectContext(buildErrorContext(store, { errorId: first.id })).error.id).toBe(first.id);
    expect(expectContext(buildErrorContext(store)).error.id).toBe(second.id);
  });

  it('reports an actionable failure when nothing matches', () => {
    const store = new EventStore();
    store.add(makeError());

    expect(buildErrorContext(store, { fingerprint: 'nope' }).error).toContain('fingerprint "nope"');
    expect(buildErrorContext(store, { errorId: 'missing' }).error).toContain('id "missing"');
    expect(buildErrorContext(new EventStore()).error).toContain('any captured error');
  });

  it('excludes signals outside the window and interactions after the error', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE - 20_000)); // before the window
    store.add(makeInteraction(BASE + 100)); // after the error: not a cause
    store.add(makeNetwork(BASE + 100)); // inside the forward buffer: kept
    store.add(makeNetwork(BASE + 5000)); // far after: excluded
    store.add(makeError());

    const context = expectContext(buildErrorContext(store));

    expect(context.precedingInteractions).toHaveLength(0);
    expect(context.relatedNetwork.map((e) => e.timestamp)).toEqual([BASE + 100]);
  });

  it('honors a custom lookback window', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE - 5000));
    store.add(makeInteraction(BASE - 500));
    store.add(makeError());

    const context = expectContext(buildErrorContext(store, {}, { lookbackMs: 1000 }));

    expect(context.precedingInteractions.map((e) => e.timestamp)).toEqual([BASE - 500]);
    expect(context.lookbackMs).toBe(1000);
  });

  it('keeps the entries closest to the error when clipping', () => {
    const store = new EventStore();
    for (let i = 0; i < 8; i += 1) {
      store.add(makeInteraction(BASE - 1000 - i));
    }
    store.add(makeError());

    const context = expectContext(buildErrorContext(store));

    expect(context.precedingInteractions).toHaveLength(5);
    // The five closest to the error, still oldest first.
    expect(context.precedingInteractions[0]?.timestamp).toBe(BASE - 1004);
    expect(context.precedingInteractions.at(-1)?.timestamp).toBe(BASE - 1000);
  });

  it('ignores other sessions and non-warning console output', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE - 100, 'session-2'));
    store.add(makeConsole(BASE - 100, 'log'));
    store.add(makeConsole(BASE - 90, 'error'));
    store.add(makeError());

    const context = expectContext(buildErrorContext(store));

    expect(context.precedingInteractions).toHaveLength(0);
    expect(context.relatedConsole.map((e) => e.level)).toEqual(['error']);
  });

  it('summarizes performance for the whole session, not just the window', () => {
    const store = new EventStore();
    // Far outside the lookback window — page-level state still counts.
    store.add(makePerformance({ timestamp: BASE - 60_000, metric: 'LCP', value: 3000 }));
    store.add(makeError());

    const context = expectContext(buildErrorContext(store));

    expect(context.performance.webVitals.LCP?.value).toBe(3000);
  });

  it('still finds the window when many newer events bury an older error', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE - 100));
    const stored = store.add(makeError()) as ErrorEvent;
    // A flood of newer events must not push the error's window out of a
    // partial scan — the whole session is scanned.
    for (let i = 0; i < 1200; i += 1) {
      store.add(makeConsole(BASE + 100_000 + i, 'log'));
    }

    const context = expectContext(buildErrorContext(store, { errorId: stored.id }));

    expect(context.precedingInteractions.map((e) => e.timestamp)).toEqual([BASE - 100]);
  });

  it('follows the latest occurrence of a folded error', () => {
    const store = new EventStore();
    const stack = 'Error: boom\n    at render (App.vue:1:1)';
    store.add(makeError({ stack, timestamp: BASE }));
    // The second occurrence arrives much later, after a fresh interaction.
    store.add(makeInteraction(BASE + 60_000));
    const folded = store.add(makeError({ stack, timestamp: BASE + 60_500 })) as ErrorEvent;

    const context = expectContext(buildErrorContext(store, { errorId: folded.id }));

    expect(context.error.occurrences).toBe(2);
    expect(context.precedingInteractions.map((e) => e.timestamp)).toEqual([BASE + 60_000]);
  });
});
