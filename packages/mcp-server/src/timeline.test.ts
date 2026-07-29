import { describe, expect, it } from 'vitest';

import type { AgentLensEvent, ConsoleEvent, InteractionEvent } from '@agentlensjs/shared';
import { buildTimeline } from './timeline';

let counter = 0;

function makeInteraction(timestamp: number, text: string): InteractionEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'interaction',
    subtype: 'click',
    timestamp,
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    target: { tag: 'button', id: null, text, source: 'src/App.tsx:10' },
  };
}

function makeConsole(timestamp: number, label: string): ConsoleEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'console',
    level: 'log',
    timestamp,
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    args: [label],
  };
}

function labels(effects: AgentLensEvent[]): string[] {
  return effects.map((event) => (event.type === 'console' ? (event.args[0] ?? '') : ''));
}

describe('buildTimeline', () => {
  it('attributes events inside the window to the preceding interaction', () => {
    const timeline = buildTimeline([
      makeInteraction(1000, 'save'),
      makeConsole(1100, 'a'),
      makeConsole(2500, 'b'),
    ]);

    expect(timeline.groups).toHaveLength(1);
    expect(labels(timeline.groups[0]?.effects ?? [])).toEqual(['a', 'b']);
    expect(timeline.background).toHaveLength(0);
  });

  it('cuts a group off at the next interaction', () => {
    const timeline = buildTimeline([
      makeInteraction(1000, 'first'),
      makeConsole(1100, 'a'),
      makeInteraction(1200, 'second'),
      makeConsole(1300, 'b'),
    ]);

    expect(timeline.groups).toHaveLength(2);
    expect(labels(timeline.groups[0]?.effects ?? [])).toEqual(['a']);
    expect(labels(timeline.groups[1]?.effects ?? [])).toEqual(['b']);
  });

  it('sends events outside any window to background', () => {
    const timeline = buildTimeline([
      makeConsole(500, 'before-any-interaction'),
      makeInteraction(1000, 'click'),
      makeConsole(9000, 'way-too-late'),
    ]);

    expect(labels(timeline.groups[0]?.effects ?? [])).toEqual([]);
    expect(labels(timeline.background)).toEqual(['before-any-interaction', 'way-too-late']);
  });

  it('respects a custom window and unsorted input', () => {
    const timeline = buildTimeline(
      [makeConsole(1400, 'late'), makeInteraction(1000, 'click'), makeConsole(1100, 'early')],
      { windowMs: 200 },
    );

    expect(labels(timeline.groups[0]?.effects ?? [])).toEqual(['early']);
    expect(labels(timeline.background)).toEqual(['late']);
  });
});
