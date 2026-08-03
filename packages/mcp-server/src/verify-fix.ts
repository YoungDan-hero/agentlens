import type { EventStore } from './store';

export interface VerifyFixOptions {
  /** How long to wait for a code update (HMR or reload). @default 10000 */
  timeoutMs?: number;
  /** Observation window after the code update, watching for recurrence. @default 3000 */
  quietWindowMs?: number;
  /** Poll interval. @default 250 */
  pollIntervalMs?: number;
}

export interface VerifyFixResult {
  verified: boolean;
  /** Whether new code reached the browser during the wait. */
  codeUpdateApplied: boolean;
  /** Whether the error recurred after the code update. */
  recurred: boolean;
  occurrencesBefore: number;
  occurrencesAfter: number;
  observedForMs: number;
  note: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QUIET_WINDOW_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Two-phase fix verification for a previously captured error:
 *
 * 1. Wait (up to `timeoutMs`) until new code reaches the browser — a hot
 *    module update or a full reload reported by the runtime.
 * 2. Observe for `quietWindowMs`; the fix is verified when the error's
 *    fingerprint does not recur in that window.
 *
 * Honest limitation: for interaction-triggered errors this proves only that
 * the error did not recur on its own; replaying the triggering interaction
 * is out of scope until the interaction timeline exists.
 */
export async function verifyFix(
  store: EventStore,
  fingerprint: string,
  options: VerifyFixOptions = {},
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<VerifyFixResult | { error: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quietWindowMs = options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const target = store.getErrorByFingerprint(fingerprint);
  if (!target) {
    return {
      error:
        `No captured error matches fingerprint "${fingerprint}". ` +
        'Call get_recent_events with type "error" to list current fingerprints.',
    };
  }

  const startedAt = Date.now();
  const occurrencesBefore = target.occurrences;
  // Origin-scoped: an HMR in a different dev server must not count.
  const origin = originOf(target.url);

  // Phase 1: wait until a code update lands *after the error's latest
  // occurrence*. Anchoring the baseline at the tool call time instead would
  // miss the primary workflow entirely: the agent edits the file first,
  // Vite applies HMR within milliseconds, and only then does the agent call
  // this tool — the update it is looking for is already in the past.
  // Both timestamps are browser-clock, so the comparison is skew-free.
  const baseline = target.timestamp;
  let codeUpdateAt = store.latestCodeUpdateSince(baseline, origin);
  while (codeUpdateAt === null && Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);
    codeUpdateAt = store.latestCodeUpdateSince(baseline, origin);
  }

  if (codeUpdateAt === null) {
    // An update that predates the error's latest occurrence deserves a
    // pointed hint: if that update WAS the fix, the error already outlived
    // it — the fix did not take.
    const staleUpdate = store.latestCodeUpdateSince(0, origin);
    return {
      verified: false,
      codeUpdateApplied: false,
      recurred: false,
      occurrencesBefore,
      occurrencesAfter: store.getErrorByFingerprint(fingerprint)?.occurrences ?? occurrencesBefore,
      observedForMs: Date.now() - startedAt,
      note:
        staleUpdate !== null
          ? 'No code update reached the browser after the error last occurred. ' +
            'An earlier update did arrive — if that was your fix, the error has ' +
            'already recurred since it, so the fix did not take.'
          : 'No code update (HMR or reload) reached the browser within the timeout. ' +
            'Make sure the fix is saved and the dev server compiled it, then retry.',
    };
  }

  // Phase 2: quiet window — any recurrence after the code update fails it.
  // The observation clock starts now, but recurrence is judged against the
  // update event's own browser-side timestamp: an error that re-fires in the
  // re-render immediately after HMR lands between the update and this poll,
  // and must count as a recurrence, not as a stale pre-update occurrence.
  const observeFrom = Date.now();
  while (Date.now() - observeFrom < quietWindowMs) {
    const current = store.getErrorByFingerprint(fingerprint);
    if (current && current.timestamp > codeUpdateAt) {
      return {
        verified: false,
        codeUpdateApplied: true,
        recurred: true,
        occurrencesBefore,
        occurrencesAfter: current.occurrences,
        observedForMs: Date.now() - startedAt,
        note: 'The error recurred after the code update — the fix did not take.',
      };
    }
    await sleep(pollIntervalMs);
  }

  return {
    verified: true,
    codeUpdateApplied: true,
    recurred: false,
    occurrencesBefore,
    occurrencesAfter: store.getErrorByFingerprint(fingerprint)?.occurrences ?? occurrencesBefore,
    observedForMs: Date.now() - startedAt,
    note:
      'Code update applied and the error did not recur in the observation window. ' +
      'If the error only fires on user interaction, re-trigger it to be fully sure.',
  };
}
