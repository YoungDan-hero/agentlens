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

  // Phase 1: wait for new code to reach the browser.
  let codeUpdateAt: number | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (store.hasCodeUpdateSince(startedAt)) {
      codeUpdateAt = Date.now();
      break;
    }
    await sleep(pollIntervalMs);
  }

  if (codeUpdateAt === null) {
    return {
      verified: false,
      codeUpdateApplied: false,
      recurred: false,
      occurrencesBefore,
      occurrencesAfter: store.getErrorByFingerprint(fingerprint)?.occurrences ?? occurrencesBefore,
      observedForMs: Date.now() - startedAt,
      note:
        'No code update (HMR or reload) reached the browser within the timeout. ' +
        'Make sure the fix is saved and the dev server compiled it, then retry.',
    };
  }

  // Phase 2: quiet window — any recurrence after the code update fails it.
  while (Date.now() - codeUpdateAt < quietWindowMs) {
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
