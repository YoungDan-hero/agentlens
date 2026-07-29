// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentLensEvent } from '@agentlensjs/shared';
import type { EventContext } from '../events';
import { installErrorCollector } from './errors';

const context: EventContext = {
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
};

function makeSink(): { events: AgentLensEvent[]; send: (event: AgentLensEvent) => void } {
  const events: AgentLensEvent[] = [];
  return { events, send: (event) => events.push(event) };
}

/** jsdom has no PromiseRejectionEvent constructor; build a stand-in. */
function makeRejectionEvent(reason: unknown): Event {
  const event = new Event('unhandledrejection');
  Object.defineProperty(event, 'reason', { value: reason });
  return event;
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
});

describe('installErrorCollector', () => {
  it('captures uncaught errors with message and stack', () => {
    const sink = makeSink();
    teardown = installErrorCollector(sink, context);

    const error = new Error('boom');
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error }));

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event?.type).toBe('error');
    if (event?.type === 'error') {
      expect(event.subtype).toBe('uncaught');
      expect(event.message).toBe('boom');
      expect(event.stack).toBe(error.stack);
    }
  });

  it('captures unhandled rejections, stringifying non-Error reasons', () => {
    const sink = makeSink();
    teardown = installErrorCollector(sink, context);

    window.dispatchEvent(makeRejectionEvent(new Error('rejected')));
    window.dispatchEvent(makeRejectionEvent('plain string'));

    expect(sink.events).toHaveLength(2);
    const [first, second] = sink.events;
    if (first?.type === 'error') {
      expect(first.subtype).toBe('unhandledrejection');
      expect(first.message).toBe('rejected');
      expect(first.stack).not.toBeNull();
    }
    if (second?.type === 'error') {
      expect(second.message).toBe('plain string');
      expect(second.stack).toBeNull();
    }
  });

  it('stops capturing after teardown', () => {
    const sink = makeSink();
    teardown = installErrorCollector(sink, context);
    teardown();
    teardown = null;

    window.dispatchEvent(new ErrorEvent('error', { message: 'late' }));
    expect(sink.events).toHaveLength(0);
  });
});
