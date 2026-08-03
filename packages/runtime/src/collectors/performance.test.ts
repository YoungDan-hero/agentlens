import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentLensEvent, PerformanceEvent } from '@agentlensjs/shared';
import type { EventContext } from '../events';
import type { EventSink } from '../transport';
import { installPerformanceCollector, rateMetric } from './performance';

const context: EventContext = {
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
};

function createSink(): { sink: EventSink; events: AgentLensEvent[] } {
  const events: AgentLensEvent[] = [];
  return {
    sink: {
      send: (event) => {
        events.push(event);
      },
    },
    events,
  };
}

function perfEvents(events: AgentLensEvent[]): PerformanceEvent[] {
  return events.filter((event): event is PerformanceEvent => event.type === 'performance');
}

interface FakeEntry {
  name?: string;
  startTime?: number;
  duration?: number;
  responseStart?: number;
  value?: number;
  hadRecentInput?: boolean;
  attribution?: { name: string; containerType?: string; containerName?: string }[];
}

/** Captures observers by entry type and lets tests push entries manually. */
class FakePerformanceObserver {
  static supportedEntryTypes = [
    'paint',
    'navigation',
    'largest-contentful-paint',
    'layout-shift',
    'event',
    'longtask',
  ];
  static byType = new Map<string, FakePerformanceObserver>();

  disconnected = false;
  private observedType = '';

  constructor(private readonly callback: (list: { getEntries: () => FakeEntry[] }) => void) {}

  observe(options: { type: string }): void {
    this.observedType = options.type;
    FakePerformanceObserver.byType.set(options.type, this);
  }

  disconnect(): void {
    this.disconnected = true;
    FakePerformanceObserver.byType.delete(this.observedType);
  }

  static emit(type: string, entries: FakeEntry[]): void {
    FakePerformanceObserver.byType.get(type)?.callback({ getEntries: () => entries });
  }
}

describe('rateMetric', () => {
  it('applies web.dev thresholds', () => {
    expect(rateMetric('LCP', 2000)).toBe('good');
    expect(rateMetric('LCP', 3000)).toBe('needs-improvement');
    expect(rateMetric('LCP', 5000)).toBe('poor');
    expect(rateMetric('CLS', 0.05)).toBe('good');
    expect(rateMetric('CLS', 0.3)).toBe('poor');
    expect(rateMetric('INP', 100)).toBe('good');
    expect(rateMetric('TTFB', 2000)).toBe('poor');
  });

  it('returns null for metrics without thresholds', () => {
    expect(rateMetric('long-task', 120)).toBeNull();
  });
});

describe('installPerformanceCollector', () => {
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePerformanceObserver.byType.clear();
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('degrades instead of crashing when supportedEntryTypes is missing', () => {
    // Safari ≤12 ships PerformanceObserver without the static property;
    // init() must not blow up over it.
    class LegacyPerformanceObserver {
      observe(): void {
        throw new Error('should never be reached without supportedEntryTypes');
      }
      disconnect(): void {
        /* noop */
      }
    }
    vi.stubGlobal('PerformanceObserver', LegacyPerformanceObserver);
    const { sink, events } = createSink();

    expect(() => {
      teardown = installPerformanceCollector(sink, context);
    }).not.toThrow();
    expect(perfEvents(events)).toHaveLength(0);
  });

  it('emits FCP once from the paint entry', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);

    FakePerformanceObserver.emit('paint', [
      { name: 'first-paint', startTime: 100 },
      { name: 'first-contentful-paint', startTime: 850 },
    ]);

    const captured = perfEvents(events);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.metric).toBe('FCP');
    expect(captured[0]?.value).toBe(850);
    expect(captured[0]?.rating).toBe('good');
  });

  it('emits TTFB from the navigation entry', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);

    FakePerformanceObserver.emit('navigation', [{ responseStart: 950 }]);

    const captured = perfEvents(events);
    expect(captured[0]?.metric).toBe('TTFB');
    expect(captured[0]?.value).toBe(950);
    expect(captured[0]?.rating).toBe('needs-improvement');
  });

  it('re-emits LCP for every new candidate', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);

    FakePerformanceObserver.emit('largest-contentful-paint', [{ startTime: 900 }]);
    FakePerformanceObserver.emit('largest-contentful-paint', [
      { startTime: 900 },
      { startTime: 2800 },
    ]);

    const captured = perfEvents(events);
    expect(captured.map((event) => event.value)).toEqual([900, 2800]);
    expect(captured[1]?.rating).toBe('needs-improvement');
  });

  it('accumulates CLS and ships one event per quiet window', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);

    FakePerformanceObserver.emit('layout-shift', [
      { value: 0.05, hadRecentInput: false },
      { value: 0.9, hadRecentInput: true },
    ]);
    FakePerformanceObserver.emit('layout-shift', [{ value: 0.07, hadRecentInput: false }]);
    expect(perfEvents(events)).toHaveLength(0);

    vi.advanceTimersByTime(1000);

    const captured = perfEvents(events);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.metric).toBe('CLS');
    expect(captured[0]?.value).toBeCloseTo(0.12);
    expect(captured[0]?.rating).toBe('needs-improvement');
  });

  it('emits INP only when a new worst interaction appears', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);

    FakePerformanceObserver.emit('event', [{ name: 'click', duration: 120 }]);
    FakePerformanceObserver.emit('event', [{ name: 'keydown', duration: 80 }]);
    FakePerformanceObserver.emit('event', [{ name: 'click', duration: 600 }]);

    const captured = perfEvents(events);
    expect(captured.map((event) => event.value)).toEqual([120, 600]);
    expect(captured[1]?.rating).toBe('poor');
    expect(captured[1]?.detail).toBe('click');
  });

  it('emits each long task with its attribution', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);

    FakePerformanceObserver.emit('longtask', [
      { duration: 180, attribution: [{ name: 'script', containerType: 'iframe' }] },
      { duration: 75 },
    ]);

    const captured = perfEvents(events);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.metric).toBe('long-task');
    expect(captured[0]?.value).toBe(180);
    expect(captured[0]?.rating).toBeNull();
    expect(captured[0]?.detail).toBe('iframe:script');
    expect(captured[1]?.detail).toBeNull();
  });

  it('disconnects all observers on teardown', () => {
    const { sink, events } = createSink();
    teardown = installPerformanceCollector(sink, context);
    const observer = FakePerformanceObserver.byType.get('paint');

    teardown();
    teardown = undefined;

    expect(observer?.disconnected).toBe(true);
    FakePerformanceObserver.emit('longtask', [{ duration: 100 }]);
    expect(perfEvents(events)).toHaveLength(0);
  });

  it('is a no-op when PerformanceObserver is unavailable', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('PerformanceObserver', undefined);
    const { sink, events } = createSink();

    teardown = installPerformanceCollector(sink, context);

    expect(perfEvents(events)).toHaveLength(0);
  });
});
