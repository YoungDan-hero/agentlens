import type { LifecycleEvent } from '@agentlensjs/shared';
import { describe, expect, it } from 'vitest';

import { EventStore } from './store';
import { waitForIdle } from './wait-for-idle';

function makeLifecycle(sessionId: string, timestamp: number): LifecycleEvent {
  return {
    id: crypto.randomUUID(),
    type: 'lifecycle',
    timestamp,
    sessionId,
    url: 'http://localhost:5173/',
    phase: 'load',
  };
}

describe('waitForIdle', () => {
  it('is idle immediately for an empty store and for an old event stream', async () => {
    const empty = await waitForIdle(new EventStore(), { quietMs: 200 });
    expect(empty.idle).toBe(true);
    expect(empty.lastEventAt).toBeNull();

    const store = new EventStore();
    store.add(makeLifecycle('s1', Date.now() - 60_000));
    const old = await waitForIdle(store, { quietMs: 200 });
    expect(old.idle).toBe(true);
    expect(old.waitedMs).toBeLessThan(150);
  });

  it('waits out recent activity before reporting idle', async () => {
    const store = new EventStore();
    store.add(makeLifecycle('s1', Date.now()));

    const result = await waitForIdle(store, { quietMs: 300, timeoutMs: 2000 });
    expect(result.idle).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(200);
  });

  it('times out when events keep arriving', async () => {
    const store = new EventStore();
    // Seed activity now — the interval alone would leave the store empty
    // (= idle) on the very first check.
    store.add(makeLifecycle('s1', Date.now()));
    const noisy = setInterval(() => store.add(makeLifecycle('s1', Date.now())), 100);

    const result = await waitForIdle(store, { quietMs: 500, timeoutMs: 700 });
    clearInterval(noisy);
    expect(result.idle).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(700);
  });

  it('defaults to the most recently active session and ignores later noise elsewhere', async () => {
    const store = new EventStore();
    // The active session's last event is fresh; a background session then
    // keeps emitting during the wait. Unscoped polling would never go
    // idle; the documented default pins the initially most recent session.
    store.add(makeLifecycle('active', Date.now()));
    const noisy = setInterval(() => store.add(makeLifecycle('background', Date.now())), 50);

    const result = await waitForIdle(store, { quietMs: 200, timeoutMs: 2000 });
    clearInterval(noisy);
    expect(result.idle).toBe(true);
  });

  it('scopes idleness to the requested session', async () => {
    const store = new EventStore();
    // Another session is noisy, but the scoped one has been quiet forever.
    const noisy = setInterval(() => store.add(makeLifecycle('other', Date.now())), 100);
    store.add(makeLifecycle('quiet', Date.now() - 60_000));

    const result = await waitForIdle(store, { quietMs: 300, sessionId: 'quiet' });
    clearInterval(noisy);
    expect(result.idle).toBe(true);
    expect(result.waitedMs).toBeLessThan(200);
  });
});
