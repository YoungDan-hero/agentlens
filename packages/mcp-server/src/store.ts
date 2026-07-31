import type { AgentLensEvent, AgentLensEventType, ErrorEvent } from '@agentlensjs/shared';

export interface EventQuery {
  type?: AgentLensEventType;
  /** Only return events newer than this epoch-milliseconds timestamp. */
  sinceMs?: number;
  /** Only return events belonging to this page session. */
  sessionId?: string;
  /** Max number of events to return, newest first. */
  limit?: number;
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
      if (query.sinceMs !== undefined && event.timestamp < query.sinceMs) {
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
   * Whether new code reached the browser after `sinceMs` — either a hot
   * module update or a full page (re)load.
   */
  hasCodeUpdateSince(sinceMs: number): boolean {
    return this.events.some(
      (event) =>
        event.type === 'lifecycle' &&
        (event.phase === 'hmr-update' || event.phase === 'load') &&
        event.timestamp > sinceMs,
    );
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
    this.sessions.set(event.sessionId, {
      sessionId: event.sessionId,
      url: event.url,
      firstSeenAt: event.timestamp,
      lastSeenAt: event.timestamp,
      eventCount: 1,
    });
  }
}
