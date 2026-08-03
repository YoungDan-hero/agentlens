import type {
  AgentLensEvent,
  AgentLensEventType,
  ErrorEvent,
  StackFrame,
} from '@agentlensjs/shared';

export interface EventQuery {
  type?: AgentLensEventType;
  /** Only return events newer than this epoch-milliseconds timestamp. */
  sinceMs?: number;
  /** Only return events belonging to this page session. */
  sessionId?: string;
  /** Max number of events to return, newest first. */
  limit?: number;
  /**
   * Only return events attributed to this source file: interactions on
   * elements the file renders, errors whose resolved stack passes through
   * it, network requests it initiated. Accepts `src/App.vue` (whole file)
   * or `src/App.vue:42` (exact line).
   */
  source?: string;
}

export interface SessionInfo {
  sessionId: string;
  url: string;
  firstSeenAt: number;
  lastSeenAt: number;
  eventCount: number;
}

export interface HealthSummary {
  /** Session the summary describes (the most recently active one). */
  sessionId: string | null;
  sessionCount: number;
  totalEvents: number;
  /** Distinct errors after fingerprint folding. */
  errorCount: number;
  /** Total error occurrences including folded repeats. */
  errorOccurrences: number;
  failedRequestCount: number;
  lastEventAt: number | null;
  windowMs: number;
}

const DEFAULT_CAPACITY = 5000;
const DEFAULT_QUERY_LIMIT = 50;
/**
 * Sessions are minted per page load, so a long dev day easily creates
 * hundreds. Cap the index and evict the least recently active: their
 * events have long been pushed out of the ring buffer anyway.
 */
const MAX_SESSIONS = 100;

/** Origin of a page URL, or null when it cannot be parsed. */
function urlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Strips leading `/` and `./` so attribution values and resolved stack
 *  frame paths compare cleanly despite their different origins. */
function normalizePath(path: string): string {
  return path.replace(/^\.?\//, '');
}

/** Splits `src/App.vue:42` into file and line; plain paths keep line null. */
function splitSourceRef(ref: string): { file: string; line: number | null } {
  const match = /^(.*):(\d+)$/.exec(ref);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { file: normalizePath(match[1]), line: Number(match[2]) };
  }
  return { file: normalizePath(ref), line: null };
}

/**
 * Resolved frame paths vary by sourcemap flavor: relative (`src/App.vue`),
 * rooted or absolute (`/Users/.../src/App.vue`), or basename-only (`App.vue`
 * — what @vitejs/plugin-vue emits for SFCs). Boundary-aware suffix matching
 * in both directions covers all of them without `NotApp.vue`-style false
 * positives; basename-only maps trade a little directory precision for not
 * silently missing every Vue frame.
 */
function fileNameMatches(fileName: string, file: string): boolean {
  const normalized = normalizePath(fileName);
  return normalized === file || normalized.endsWith(`/${file}`) || file.endsWith(`/${normalized}`);
}

function frameMatches(frames: StackFrame[], file: string, line: number | null): boolean {
  return frames.some(
    (frame) =>
      frame.fileName !== null &&
      fileNameMatches(frame.fileName, file) &&
      (line === null || frame.line === line),
  );
}

/** Whether an event is attributed to the given source file (or file:line). */
function matchesSource(event: AgentLensEvent, filter: string): boolean {
  const { file, line } = splitSourceRef(filter);
  if (event.type === 'interaction') {
    if (event.target.source === null) {
      return false;
    }
    const target = splitSourceRef(event.target.source);
    // Same tolerant path comparison as stack frames, so `App.vue` and
    // `src/App.vue` behave identically across event kinds.
    return fileNameMatches(target.file, file) && (line === null || target.line === line);
  }
  if (event.type === 'error') {
    return frameMatches(event.frames, file, line);
  }
  if (event.type === 'network') {
    return frameMatches(event.initiatorFrames, file, line);
  }
  return false;
}

function errorFingerprint(event: ErrorEvent): string {
  // Message plus the top raw stack frame distinguishes same-message errors
  // thrown from different places.
  const topFrame = event.stack?.split('\n')[1]?.trim() ?? '';
  return `${event.subtype}|${event.message}|${topFrame}`;
}

/**
 * Bounded in-memory event store. Acts as the daemon's short-term memory so
 * agents can query signals that occurred before they were invoked.
 *
 * Identical errors (same fingerprint) are folded into a single record with
 * an `occurrences` counter, so an error storm inside a render loop cannot
 * flush useful signals out of the buffer.
 */
export class EventStore {
  private events: AgentLensEvent[] = [];
  private readonly errorsByFingerprint = new Map<string, ErrorEvent>();
  private readonly sessions = new Map<string, SessionInfo>();

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) {
      throw new RangeError('EventStore capacity must be a positive integer');
    }
  }

  /**
   * Ingests an event and returns the canonical stored record: the event
   * itself, or the existing record it was folded into.
   */
  add(event: AgentLensEvent): AgentLensEvent {
    this.trackSession(event);

    if (event.type === 'error') {
      const fingerprint = errorFingerprint(event);
      const existing = this.errorsByFingerprint.get(fingerprint);
      if (existing) {
        existing.occurrences += event.occurrences;
        existing.timestamp = event.timestamp;
        // The canonical record follows its latest occurrence, so a reload
        // (new session) cannot hide a still-recurring error from
        // session-scoped queries and health summaries.
        existing.sessionId = event.sessionId;
        existing.url = event.url;
        // Re-insert at the newest position: `query` returns events in array
        // order (newest first), so a still-recurring error must not stay
        // buried at its first-occurrence slot where newer events would push
        // it out of the default query window.
        const index = this.events.indexOf(existing);
        if (index !== -1) {
          this.events.splice(index, 1);
          this.events.push(existing);
        }
        return existing;
      }
      // Expose the identity so agents can reference this error in verify_fix.
      event.fingerprint = fingerprint;
      this.errorsByFingerprint.set(fingerprint, event);
    }

    this.events.push(event);
    if (this.events.length > this.capacity) {
      const evicted = this.events.shift();
      if (evicted?.type === 'error') {
        const fingerprint = errorFingerprint(evicted);
        if (this.errorsByFingerprint.get(fingerprint) === evicted) {
          this.errorsByFingerprint.delete(fingerprint);
        }
      }
    }
    return event;
  }

  /** Returns matching events, newest first. */
  query(query: EventQuery = {}): AgentLensEvent[] {
    const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
    const result: AgentLensEvent[] = [];

    for (let i = this.events.length - 1; i >= 0 && result.length < limit; i -= 1) {
      const event = this.events[i];
      if (!event) {
        continue;
      }
      if (query.type !== undefined && event.type !== query.type) {
        continue;
      }
      if (query.sessionId !== undefined && event.sessionId !== query.sessionId) {
        continue;
      }
      // Strictly newer, as documented — callers pass the timestamp of the
      // last event they saw and must not receive it again.
      if (query.sinceMs !== undefined && event.timestamp <= query.sinceMs) {
        continue;
      }
      if (query.source !== undefined && !matchesSource(event, query.source)) {
        continue;
      }
      result.push(event);
    }
    return result;
  }

  /** Looks up the canonical (folded) error record by its fingerprint. */
  getErrorByFingerprint(fingerprint: string): ErrorEvent | undefined {
    return this.errorsByFingerprint.get(fingerprint);
  }

  /**
   * Looks up an error by its event id. Folded repeats keep the first
   * occurrence's id, so the id an agent saw in any query stays valid.
   */
  getErrorById(id: string): ErrorEvent | undefined {
    return this.events.find(
      (event): event is ErrorEvent => event.type === 'error' && event.id === id,
    );
  }

  /**
   * Timestamp (browser clock) of the latest code update — a hot module
   * update or full page (re)load — strictly after `sinceMs`, or null.
   *
   * When `origin` is given, only lifecycle events from pages of that origin
   * count: with two dev servers running, an HMR in the *other* project must
   * not read as "the fix reached this app". Session ids cannot scope this —
   * a full reload mints a new session — but the origin is stable.
   */
  latestCodeUpdateSince(sinceMs: number, origin?: string): number | null {
    let latest: number | null = null;
    for (const event of this.events) {
      if (
        event.type === 'lifecycle' &&
        (event.phase === 'hmr-update' || event.phase === 'load') &&
        event.timestamp > sinceMs &&
        (origin === undefined || urlOrigin(event.url) === origin) &&
        (latest === null || event.timestamp > latest)
      ) {
        latest = event.timestamp;
      }
    }
    return latest;
  }

  /** Sessions ordered by most recent activity first. */
  listSessions(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * Health summary scoped to one session — by default the most recently
   * active one, so parallel tabs or E2E runs don't pollute the answer.
   */
  summarize(windowMs: number, sessionId?: string): HealthSummary {
    const targetSession = sessionId ?? this.listSessions()[0]?.sessionId ?? null;
    const sinceMs = Date.now() - windowMs;
    const recent = this.events.filter(
      (event) =>
        event.timestamp >= sinceMs && (targetSession === null || event.sessionId === targetSession),
    );
    const errors = recent.filter((event): event is ErrorEvent => event.type === 'error');
    const lastEvent = recent.at(-1);

    return {
      sessionId: targetSession,
      sessionCount: this.sessions.size,
      totalEvents: recent.length,
      errorCount: errors.length,
      errorOccurrences: errors.reduce((sum, event) => sum + event.occurrences, 0),
      // Beacons are fire-and-forget: their status is null by design, which
      // must not read as a transport failure.
      failedRequestCount: recent.filter(
        (event) =>
          event.type === 'network' &&
          event.transport !== 'beacon' &&
          (event.status === null || event.status >= 400),
      ).length,
      lastEventAt: lastEvent?.timestamp ?? null,
      windowMs,
    };
  }

  get size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    this.errorsByFingerprint.clear();
    this.sessions.clear();
  }

  private trackSession(event: AgentLensEvent): void {
    const existing = this.sessions.get(event.sessionId);
    if (existing) {
      existing.lastSeenAt = Math.max(existing.lastSeenAt, event.timestamp);
      existing.eventCount += 1;
      return;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      let oldest: SessionInfo | null = null;
      for (const session of this.sessions.values()) {
        if (oldest === null || session.lastSeenAt < oldest.lastSeenAt) {
          oldest = session;
        }
      }
      if (oldest) {
        this.sessions.delete(oldest.sessionId);
      }
    }
    this.sessions.set(event.sessionId, {
      sessionId: event.sessionId,
      url: event.url,
      firstSeenAt: event.timestamp,
      lastSeenAt: event.timestamp,
      eventCount: 1,
    });
  }
}
