import type { ConsoleEvent, ErrorEvent, InteractionEvent, NetworkEvent } from '@agentlensjs/shared';

import type { PerformanceSummary } from './performance-summary';
import { summarizePerformance } from './performance-summary';
import type { EventStore, SessionInfo } from './store';

export interface ErrorContextRef {
  /** Fingerprint of the folded error record (from get_page_health / get_recent_events). */
  fingerprint?: string;
  /** Event id of the canonical error record. */
  errorId?: string;
}

export interface ErrorContextOptions {
  /** How far before the error's latest occurrence to look for causes. */
  lookbackMs?: number;
}

/**
 * Everything an agent needs to reason about one error in a single call,
 * assembled from signals the store already holds.
 */
export interface ErrorContext {
  /** Canonical (folded) error record, including source-mapped frames. */
  error: ErrorEvent;
  session: SessionInfo | null;
  /**
   * Interactions that preceded the latest occurrence, oldest first — the
   * likely trigger is usually the last one.
   */
  precedingInteractions: InteractionEvent[];
  /** Network requests inside the window, oldest first. */
  relatedNetwork: NetworkEvent[];
  /** Console warnings and errors inside the window, oldest first. */
  relatedConsole: ConsoleEvent[];
  /** Session-wide Web Vitals and long-task pressure at the time of the call. */
  performance: PerformanceSummary;
  /** The window actually applied, echoed for transparency. */
  lookbackMs: number;
}

export interface ErrorContextFailure {
  error: string;
}

const DEFAULT_LOOKBACK_MS = 15_000;
/**
 * Effects can be stamped slightly after the error within the same tick or
 * micro-batch; a small forward buffer keeps them from being cut off.
 */
const AFTER_BUFFER_MS = 500;
const MAX_INTERACTIONS = 5;
const MAX_RELATED = 10;

function resolveError(store: EventStore, ref: ErrorContextRef): ErrorEvent | undefined {
  if (ref.fingerprint !== undefined) {
    return store.getErrorByFingerprint(ref.fingerprint);
  }
  if (ref.errorId !== undefined) {
    return store.getErrorById(ref.errorId);
  }
  const [latest] = store.query({ type: 'error', limit: 1 });
  return latest?.type === 'error' ? latest : undefined;
}

/**
 * Aggregates the root-cause bundle for one error: the canonical record, the
 * interactions leading up to its latest occurrence, network and console
 * signals in the same time window, and the session's performance picture.
 *
 * Pure store-side aggregation — replaces the multi-tool round trip an agent
 * would otherwise need to correlate by hand.
 */
export function buildErrorContext(
  store: EventStore,
  ref: ErrorContextRef = {},
  options: ErrorContextOptions = {},
): ErrorContext | ErrorContextFailure {
  const error = resolveError(store, ref);
  if (!error) {
    const wanted =
      ref.fingerprint !== undefined
        ? `fingerprint "${ref.fingerprint}"`
        : ref.errorId !== undefined
          ? `id "${ref.errorId}"`
          : 'any captured error';
    return {
      error:
        `No error matches ${wanted}. It may have been evicted from the bounded ` +
        'store, or no error occurred yet — check get_page_health first.',
    };
  }

  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const windowStart = error.timestamp - lookbackMs;
  const windowEnd = error.timestamp + AFTER_BUFFER_MS;

  // One session-scoped scan over the whole store, then windowed slices per
  // signal kind. No cap here: a partial scan would silently miss the window
  // of an older error once enough newer events pile up in the session — the
  // output size is bounded by the window and the per-kind clips below.
  // The folded error's timestamp tracks its latest occurrence, so the
  // window follows the most recent trigger.
  const sessionEvents = store.query({ sessionId: error.sessionId, limit: store.size });

  const interactions: InteractionEvent[] = [];
  const network: NetworkEvent[] = [];
  const consoleEvents: ConsoleEvent[] = [];
  for (const event of sessionEvents) {
    if (event.timestamp < windowStart || event.timestamp > windowEnd) {
      continue;
    }
    if (event.type === 'interaction' && event.timestamp <= error.timestamp) {
      interactions.push(event);
    } else if (event.type === 'network') {
      network.push(event);
    } else if (event.type === 'console' && (event.level === 'warn' || event.level === 'error')) {
      consoleEvents.push(event);
    }
  }

  // Store order is insertion order, not timestamp order (folded errors get
  // re-positioned, micro-batches may interleave) — sort explicitly, keep the
  // entries closest to the error and present them oldest first, the order an
  // agent reads a causal chain in.
  const clip = <T extends { timestamp: number }>(events: T[], max: number): T[] =>
    [...events].sort((a, b) => a.timestamp - b.timestamp).slice(-max);

  return {
    error,
    session: store.listSessions().find((s) => s.sessionId === error.sessionId) ?? null,
    precedingInteractions: clip(interactions, MAX_INTERACTIONS),
    relatedNetwork: clip(network, MAX_RELATED),
    relatedConsole: clip(consoleEvents, MAX_RELATED),
    // Vitals describe page-level state, not a moment — summarize the whole
    // session rather than the window. The limit must cover everything the
    // store can hold: FCP/TTFB fire once at page load, and a janky session
    // emits enough long-tasks to push them out of any small newest-first
    // sample — precisely the sessions where those vitals matter most.
    performance: summarizePerformance(
      store.query({ type: 'performance', sessionId: error.sessionId, limit: Infinity }),
    ),
    lookbackMs,
  };
}
