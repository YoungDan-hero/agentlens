import type { AgentLensEvent, PerformanceEvent, PerformanceRating } from '@agentlensjs/shared';

/** Latest observed value of one Web Vital. */
export interface MetricReading {
  value: number;
  rating: PerformanceRating | null;
  capturedAt: number;
}

export interface LongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number;
  /** Most recent tasks, newest first, capped. */
  recent: { durationMs: number; detail: string | null; timestamp: number }[];
}

export type WebVitalName = 'FCP' | 'LCP' | 'CLS' | 'INP' | 'TTFB';

export interface PerformanceSummary {
  /** Null when the metric has not been observed yet. */
  webVitals: Record<WebVitalName, MetricReading | null>;
  longTasks: LongTaskSummary;
  /** Total performance events considered. */
  eventCount: number;
}

const WEB_VITALS: readonly WebVitalName[] = ['FCP', 'LCP', 'CLS', 'INP', 'TTFB'];
const MAX_RECENT_LONG_TASKS = 10;

/**
 * Reduces a stream of performance events into the current picture: the
 * latest reading per Web Vital (the runtime re-emits evolving metrics, so
 * latest wins) and aggregate long-task pressure.
 */
export function summarizePerformance(events: readonly AgentLensEvent[]): PerformanceSummary {
  const perfEvents = events.filter(
    (event): event is PerformanceEvent => event.type === 'performance',
  );

  const webVitals = Object.fromEntries(WEB_VITALS.map((name) => [name, null])) as Record<
    WebVitalName,
    MetricReading | null
  >;
  const longTasks: LongTaskSummary = { count: 0, totalMs: 0, maxMs: 0, recent: [] };

  for (const event of perfEvents) {
    if (event.metric === 'long-task') {
      longTasks.count += 1;
      longTasks.totalMs += event.value;
      longTasks.maxMs = Math.max(longTasks.maxMs, event.value);
      longTasks.recent.push({
        durationMs: event.value,
        detail: event.detail,
        timestamp: event.timestamp,
      });
      continue;
    }
    const current = webVitals[event.metric];
    if (!current || event.timestamp >= current.capturedAt) {
      webVitals[event.metric] = {
        value: event.value,
        rating: event.rating,
        capturedAt: event.timestamp,
      };
    }
  }

  longTasks.totalMs = Math.round(longTasks.totalMs);
  // Newest first regardless of input order, capped after sorting.
  longTasks.recent.sort((a, b) => b.timestamp - a.timestamp);
  longTasks.recent = longTasks.recent.slice(0, MAX_RECENT_LONG_TASKS);

  return { webVitals, longTasks, eventCount: perfEvents.length };
}
