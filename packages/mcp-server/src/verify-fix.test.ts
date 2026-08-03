import { describe, expect, it } from 'vitest';

import type { ErrorEvent, LifecycleEvent } from '@agentlensjs/shared';
import { EventStore } from './store';
import { verifyFix, type VerifyFixResult } from './verify-fix';

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
    stack: 'Error: boom\n    at render (App.tsx:1:1)',
    frames: [],
    occurrences: 1,
    ...overrides,
  };
}

function makeHmrUpdate(timestamp: number): LifecycleEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'lifecycle',
    timestamp,
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    phase: 'hmr-update',
  };
}

/** Fast, deterministic options: single poll tick per phase. */
const FAST = { timeoutMs: 60, quietWindowMs: 60, pollIntervalMs: 10 };

function storedFingerprint(store: EventStore, error: ErrorEvent): string {
  const stored = store.add(error);
  const fingerprint = stored.type === 'error' ? stored.fingerprint : undefined;
  if (fingerprint === undefined) {
    throw new Error('expected the store to assign a fingerprint');
  }
  return fingerprint;
}

function asResult(value: VerifyFixResult | { error: string }): VerifyFixResult {
  if ('error' in value) {
    throw new Error(`unexpected error result: ${value.error}`);
  }
  return value;
}

describe('verifyFix', () => {
  it('rejects an unknown fingerprint with a hint', async () => {
    const store = new EventStore();
    const result = await verifyFix(store, 'nope', FAST);
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('get_recent_events');
    }
  });

  it('is not verified when no code update arrives within the timeout', async () => {
    const store = new EventStore();
    const fingerprint = storedFingerprint(store, makeError());

    const result = asResult(await verifyFix(store, fingerprint, FAST));
    expect(result.verified).toBe(false);
    expect(result.codeUpdateApplied).toBe(false);
    expect(result.note).toContain('No code update');
  });

  it('verifies when an HMR update lands and the error stays quiet', async () => {
    const store = new EventStore();
    const fingerprint = storedFingerprint(store, makeError());

    const pending = verifyFix(store, fingerprint, FAST);
    store.add(makeHmrUpdate(Date.now() + 1));

    const result = asResult(await pending);
    expect(result.verified).toBe(true);
    expect(result.codeUpdateApplied).toBe(true);
    expect(result.recurred).toBe(false);
    expect(result.occurrencesBefore).toBe(1);
    expect(result.occurrencesAfter).toBe(1);
  });

  it('fails verification when the error recurs after the update', async () => {
    const store = new EventStore();
    const original = makeError();
    const fingerprint = storedFingerprint(store, original);

    const pending = verifyFix(store, fingerprint, {
      timeoutMs: 200,
      quietWindowMs: 200,
      pollIntervalMs: 10,
    });
    store.add(makeHmrUpdate(Date.now() + 1));
    // Recurrence: same fingerprint, timestamped after the update.
    setTimeout(() => {
      store.add(makeError({ timestamp: Date.now() + 1 }));
    }, 40);

    const result = asResult(await pending);
    expect(result.verified).toBe(false);
    expect(result.recurred).toBe(true);
    expect(result.occurrencesAfter).toBe(2);
  });

  it('ignores recurrences that happened before the code update', async () => {
    const store = new EventStore();
    const fingerprint = storedFingerprint(store, makeError());

    const pending = verifyFix(store, fingerprint, FAST);
    // Old code still running: the error fires again, then the update lands.
    store.add(makeError({ timestamp: Date.now() }));
    store.add(makeHmrUpdate(Date.now() + 5));

    const result = asResult(await pending);
    expect(result.verified).toBe(true);
    expect(result.occurrencesBefore).toBe(1);
    expect(result.occurrencesAfter).toBe(2);
  });

  it('sees a code update that landed before the tool was called', async () => {
    // The primary workflow: agent edits the file, Vite applies HMR within
    // milliseconds, and only then does the agent invoke verify_fix. The
    // update is already in the store when the tool starts.
    const store = new EventStore();
    const fingerprint = storedFingerprint(store, makeError({ timestamp: Date.now() - 500 }));
    store.add(makeHmrUpdate(Date.now() - 100));

    const result = asResult(await verifyFix(store, fingerprint, FAST));
    expect(result.codeUpdateApplied).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('ignores code updates from a different origin (second dev server)', async () => {
    const store = new EventStore();
    const fingerprint = storedFingerprint(store, makeError({ timestamp: Date.now() - 500 }));
    // Another project's HMR on another port must not read as "fix arrived".
    store.add({
      ...makeHmrUpdate(Date.now() - 100),
      url: 'http://localhost:4000/',
      sessionId: 'other-app',
    });

    const result = asResult(await verifyFix(store, fingerprint, FAST));
    expect(result.codeUpdateApplied).toBe(false);
    expect(result.note).toContain('No code update');
  });

  it('hints when the only update predates the error\u2019s latest occurrence', async () => {
    // Fix applied → error recurred after it → agent calls the tool. There
    // is no update newer than the recurrence, but the stale one deserves a
    // pointed note: if that was the fix, it did not take.
    const store = new EventStore();
    const now = Date.now();
    store.add(makeHmrUpdate(now - 300));
    const fingerprint = storedFingerprint(store, makeError({ timestamp: now - 100 }));

    const result = asResult(await verifyFix(store, fingerprint, FAST));
    expect(result.codeUpdateApplied).toBe(false);
    expect(result.note).toContain('already recurred');
  });

  it('counts a recurrence that fires immediately after the update lands', async () => {
    // The recurrence timestamp sits between the HMR event and the poll that
    // discovers it; judging against poll wall-clock time would misread it
    // as a stale pre-update occurrence.
    const store = new EventStore();
    const fingerprint = storedFingerprint(store, makeError());

    const pending = verifyFix(store, fingerprint, {
      timeoutMs: 200,
      quietWindowMs: 200,
      pollIntervalMs: 10,
    });
    const updateAt = Date.now() + 1;
    store.add(makeHmrUpdate(updateAt));
    // Re-render error: one millisecond after the update, long before the
    // next poll tick.
    store.add(makeError({ timestamp: updateAt + 1 }));

    const result = asResult(await pending);
    expect(result.verified).toBe(false);
    expect(result.recurred).toBe(true);
  });
});
