import type { AgentLensEvent, PerformanceEvent } from '@agentlensjs/shared';
import { describe, expect, it } from 'vitest';

import { summarizePerformance } from './performance-summary';

let counter = 0;

function makePerf(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
  counter += 1;
  return {
    id: `perf-${String(counter)}`,
    type: 'performance',
    timestamp: counter,
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    metric: 'LCP',
    value: 1000,
    rating: 'good',
    detail: null,
    ...overrides,
  };
}

describe('summarizePerformance', () => {
  it('returns null readings and empty long tasks for no input', () => {
    const summary = summarizePerformance([]);
    expect(summary.webVitals).toEqual({ FCP: null, LCP: null, CLS: null, INP: null, TTFB: null });
    expect(summary.longTasks).toEqual({ count: 0, totalMs: 0, maxMs: 0, recent: [] });
    expect(summary.eventCount).toBe(0);
  });

  it('keeps the latest reading per web vital', () => {
    const summary = summarizePerformance([
      makePerf({ metric: 'LCP', value: 900, timestamp: 100 }),
      makePerf({ metric: 'LCP', value: 2800, rating: 'needs-improvement', timestamp: 200 }),
      makePerf({ metric: 'CLS', value: 0.02, timestamp: 150 }),
    ]);

    expect(summary.webVitals.LCP).toEqual({
      value: 2800,
      rating: 'needs-improvement',
      capturedAt: 200,
    });
    expect(summary.webVitals.CLS?.value).toBe(0.02);
    expect(summary.webVitals.INP).toBeNull();
  });

  it('is order-independent: latest timestamp wins even when listed first', () => {
    const summary = summarizePerformance([
      makePerf({ metric: 'INP', value: 600, timestamp: 500 }),
      makePerf({ metric: 'INP', value: 120, timestamp: 100 }),
    ]);
    expect(summary.webVitals.INP?.value).toBe(600);
  });

  it('aggregates long tasks and caps the recent list, newest first', () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      makePerf({
        metric: 'long-task',
        value: 50 + index,
        rating: null,
        detail: `task-${String(index)}`,
        timestamp: 1000 + index,
      }),
    );
    const summary = summarizePerformance(tasks);

    expect(summary.longTasks.count).toBe(12);
    expect(summary.longTasks.maxMs).toBe(61);
    expect(summary.longTasks.totalMs).toBe(tasks.reduce((sum, task) => sum + task.value, 0));
    expect(summary.longTasks.recent).toHaveLength(10);
    expect(summary.longTasks.recent[0]?.timestamp).toBe(1011);
  });

  it('ignores non-performance events', () => {
    const interaction: AgentLensEvent = {
      id: 'i1',
      type: 'interaction',
      subtype: 'click',
      timestamp: 1,
      sessionId: 'session-1',
      url: 'http://localhost:5173/',
      target: { tag: 'button', id: null, text: null, source: null },
    };
    const summary = summarizePerformance([interaction, makePerf({ metric: 'FCP', value: 800 })]);
    expect(summary.eventCount).toBe(1);
    expect(summary.webVitals.FCP?.value).toBe(800);
  });
});
