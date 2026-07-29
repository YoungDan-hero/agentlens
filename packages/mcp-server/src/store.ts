import type { AgentLensEvent, AgentLensEventType } from '@agentlens/shared';

export interface EventQuery {
  type?: AgentLensEventType;
  /** Only return events newer than this epoch-milliseconds timestamp. */
  sinceMs?: number;
  /** Max number of events to return, newest first. */
  limit?: number;
}

export interface HealthSummary {
  totalEvents: number;
  errorCount: number;
  failedRequestCount: number;
  lastEventAt: number | null;
  windowMs: number;
}

const DEFAULT_CAPACITY = 5000;
const DEFAULT_QUERY_LIMIT = 50;

/**
 * Bounded in-memory event store. Acts as the daemon's short-term memory so
 * agents can query signals that occurred before they were invoked.
 */
export class EventStore {
  private events: AgentLensEvent[] = [];

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {
    if (capacity <= 0) {
      throw new RangeError('EventStore capacity must be a positive integer');
    }
  }

  add(event: AgentLensEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
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
      if (query.sinceMs !== undefined && event.timestamp < query.sinceMs) {
        // Events are appended in arrival order; older entries cannot match either.
        break;
      }
      result.push(event);
    }
    return result;
  }

  summarize(windowMs: number): HealthSummary {
    const sinceMs = Date.now() - windowMs;
    const recent = this.events.filter((event) => event.timestamp >= sinceMs);
    const lastEvent = this.events.at(-1);

    return {
      totalEvents: recent.length,
      errorCount: recent.filter((event) => event.type === 'error').length,
      failedRequestCount: recent.filter(
        (event) => event.type === 'network' && (event.status === null || event.status >= 400),
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
  }
}
