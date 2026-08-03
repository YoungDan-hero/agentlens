import type { EventStore } from './store';

export interface WaitForIdleOptions {
  /** The session counts as idle after this long without new events. */
  quietMs?: number;
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** Scope to one page session; defaults to the most recently active one. */
  sessionId?: string;
}

export interface WaitForIdleResult {
  /** True when the quiet window was reached, false when the wait timed out. */
  idle: boolean;
  waitedMs: number;
  /** Timestamp of the last event seen in scope; null when none exist. */
  lastEventAt: number | null;
}

const DEFAULT_QUIET_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 200;

function lastEventAt(store: EventStore, sessionId?: string): number | null {
  const [latest] = store.query({ limit: 1, ...(sessionId !== undefined && { sessionId }) });
  return latest?.timestamp ?? null;
}

/**
 * Resolves once the event stream for a session has been quiet for
 * `quietMs`, or after `timeoutMs`. Complements `perform_action`: after
 * driving the page (or waiting out an async operation), an agent can block
 * here until the app has visibly finished reacting before asserting state.
 */
export async function waitForIdle(
  store: EventStore,
  options: WaitForIdleOptions = {},
): Promise<WaitForIdleResult> {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Resolve the default scope once, as documented: without it, heartbeat
  // events from any background tab would keep "idle" out of reach forever.
  const sessionId = options.sessionId ?? store.listSessions()[0]?.sessionId;
  const startedAt = Date.now();

  for (;;) {
    const now = Date.now();
    const last = lastEventAt(store, sessionId);
    // An empty scope is idle by definition; otherwise idle means the last
    // event is at least one quiet window old.
    if (last === null || now - last >= quietMs) {
      return { idle: true, waitedMs: now - startedAt, lastEventAt: last };
    }
    if (now - startedAt >= timeoutMs) {
      return { idle: false, waitedMs: now - startedAt, lastEventAt: last };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
