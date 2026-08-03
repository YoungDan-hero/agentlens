// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentLensEvent } from '@agentlensjs/shared';
import type { EventContext } from '../events';
import { installInteractionCollector } from './interactions';

const context: EventContext = {
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
};

function makeSink(): { events: AgentLensEvent[]; send: (event: AgentLensEvent) => void } {
  const events: AgentLensEvent[] = [];
  return { events, send: (event) => events.push(event) };
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('interaction collector', () => {
  it('captures clicks with target description and inherited source attribution', () => {
    document.body.innerHTML =
      '<button id="save" data-agentlens-source="src/App.tsx:12"><span>Save changes</span></button>';
    const sink = makeSink();
    teardown = installInteractionCollector(sink, context);

    // The click lands on the inner span, not the button itself.
    document.querySelector('span')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event?.type).toBe('interaction');
    if (event?.type === 'interaction') {
      expect(event.subtype).toBe('click');
      expect(event.target.tag).toBe('span');
      expect(event.target.text).toBe('Save changes');
      expect(event.target.source).toBe('src/App.tsx:12');
      // Dispatched events are untrusted, so the audit marker must be set —
      // exactly how agent-driven actions are distinguished from humans.
      expect(event.synthetic).toBe(true);
    }
  });

  it('debounces input bursts per target', () => {
    document.body.innerHTML = '<input id="name" />';
    const sink = makeSink();
    teardown = installInteractionCollector(sink, context);
    const input = document.querySelector('input');

    input?.dispatchEvent(new Event('input', { bubbles: true }));
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sink.events).toHaveLength(1);

    vi.advanceTimersByTime(600);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    expect(sink.events).toHaveLength(2);
  });

  it('captures form submits and stops after teardown', () => {
    document.body.innerHTML = '<form id="checkout"><button>go</button></form>';
    const sink = makeSink();
    teardown = installInteractionCollector(sink, context);
    const form = document.querySelector('form');

    form?.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    if (event?.type === 'interaction') {
      expect(event.subtype).toBe('submit');
      expect(event.target.id).toBe('checkout');
    }

    teardown();
    teardown = null;
    form?.dispatchEvent(new Event('submit', { bubbles: true }));
    expect(sink.events).toHaveLength(1);
  });
});
