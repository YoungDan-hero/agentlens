import type { PerformanceMetric, PerformanceRating } from '@agentlensjs/shared';

import type { EventContext } from '../events';
import { buildPerformanceEvent } from '../events';
import type { EventSink } from '../transport';

/** web.dev thresholds: [good upper bound, needs-improvement upper bound]. */
const THRESHOLDS: Partial<Record<PerformanceMetric, readonly [number, number]>> = {
  FCP: [1800, 3000],
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1800],
};

export function rateMetric(metric: PerformanceMetric, value: number): PerformanceRating | null {
  const thresholds = THRESHOLDS[metric];
  if (!thresholds) {
    return null;
  }
  return value <= thresholds[0] ? 'good' : value <= thresholds[1] ? 'needs-improvement' : 'poor';
}

/** `layout-shift` entries are not part of the standard TS DOM lib. */
interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface LongTaskAttribution {
  name: string;
  containerType?: string;
  containerName?: string;
}

interface LongTaskEntry extends PerformanceEntry {
  attribution?: LongTaskAttribution[];
}

/** How long CLS accumulation stays quiet before the running total ships. */
const CLS_EMIT_DELAY_MS = 1000;

function observeEntries(
  type: string,
  callback: (entries: PerformanceEntry[]) => void,
  extraOptions: Record<string, unknown> = {},
): PerformanceObserver | null {
  // Older engines (e.g. Safari ≤12) ship PerformanceObserver without the
  // static supportedEntryTypes — its absence must degrade, not crash init.
  const supported: readonly string[] | undefined = (
    PerformanceObserver as { supportedEntryTypes?: readonly string[] }
  ).supportedEntryTypes;
  if (supported?.includes(type) !== true) {
    return null;
  }
  try {
    const observer = new PerformanceObserver((list) => {
      callback(list.getEntries());
    });
    observer.observe({ type, buffered: true, ...extraOptions });
    return observer;
  } catch {
    // Some engines throw on options they claim to support; degrade silently.
    return null;
  }
}

/**
 * Captures Web Vitals (FCP, LCP, CLS, INP, TTFB) and long tasks using the
 * native `PerformanceObserver` — no dependency on the web-vitals package.
 *
 * Metrics that evolve over the page lifetime (LCP candidates, CLS total,
 * worst INP) are re-emitted whenever they change; consumers take the latest
 * value per metric. Returns a teardown function.
 */
export function installPerformanceCollector(sink: EventSink, context: EventContext): () => void {
  if (typeof PerformanceObserver === 'undefined') {
    return () => {
      /* nothing installed, nothing to tear down */
    };
  }

  const emit = (metric: PerformanceMetric, value: number, detail: string | null = null): void => {
    sink.send(
      buildPerformanceEvent(context, {
        metric,
        value: Math.round(value * 1000) / 1000,
        rating: rateMetric(metric, value),
        detail,
      }),
    );
  };

  const observers: (PerformanceObserver | null)[] = [];
  let clsTotal = 0;
  let clsEmitTimer: ReturnType<typeof setTimeout> | null = null;
  let worstInp = 0;

  observers.push(
    observeEntries('paint', (entries) => {
      for (const entry of entries) {
        if (entry.name === 'first-contentful-paint') {
          emit('FCP', entry.startTime);
        }
      }
    }),

    observeEntries('navigation', (entries) => {
      const [navigation] = entries as PerformanceNavigationTiming[];
      if (navigation && navigation.responseStart > 0) {
        emit('TTFB', navigation.responseStart);
      }
    }),

    // Every candidate ships; the latest one is the final LCP.
    observeEntries('largest-contentful-paint', (entries) => {
      const latest = entries.at(-1);
      if (latest) {
        emit('LCP', latest.startTime);
      }
    }),

    // Shifts accumulate; the running total ships after a quiet period so a
    // shift storm becomes one event instead of dozens.
    observeEntries('layout-shift', (entries) => {
      for (const entry of entries as LayoutShiftEntry[]) {
        if (!entry.hadRecentInput) {
          clsTotal += entry.value;
        }
      }
      clsEmitTimer ??= setTimeout(() => {
        clsEmitTimer = null;
        emit('CLS', clsTotal);
      }, CLS_EMIT_DELAY_MS);
    }),

    // Worst interaction latency approximates INP well enough for dev use.
    observeEntries(
      'event',
      (entries) => {
        for (const entry of entries) {
          if (entry.duration > worstInp) {
            worstInp = entry.duration;
            emit('INP', entry.duration, entry.name);
          }
        }
      },
      { durationThreshold: 40 },
    ),

    observeEntries('longtask', (entries) => {
      for (const entry of entries as LongTaskEntry[]) {
        const attribution = entry.attribution?.[0];
        const detail = attribution
          ? [attribution.containerType, attribution.containerName, attribution.name]
              .filter((part): part is string => typeof part === 'string' && part.length > 0)
              .join(':')
          : null;
        emit('long-task', entry.duration, detail === '' ? null : detail);
      }
    }),
  );

  return () => {
    for (const observer of observers) {
      observer?.disconnect();
    }
    if (clsEmitTimer !== null) {
      clearTimeout(clsEmitTimer);
      clsEmitTimer = null;
    }
  };
}
