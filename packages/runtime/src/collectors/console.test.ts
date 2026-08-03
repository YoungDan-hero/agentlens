import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentLensEvent } from '@agentlensjs/shared';
import type { EventContext } from '../events';
import type { EventSink } from '../transport';
import { installConsoleCollector } from './console';

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

describe('installConsoleCollector', () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it('captures console calls with level and serialized args', () => {
    const { sink, events } = createSink();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    teardown = installConsoleCollector(sink, context);

    console.warn('watch out', { code: 42 });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('console');
    if (event?.type === 'console') {
      expect(event.level).toBe('warn');
      expect(event.args).toEqual(['watch out', '{"code":42}']);
    }
    // The original console method must still be invoked.
    expect(spy).toHaveBeenCalledWith('watch out', { code: 42 });
  });

  it('stops capturing after teardown', () => {
    const { sink, events } = createSink();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    teardown = installConsoleCollector(sink, context);
    teardown();
    teardown = undefined;

    console.info('after teardown');
    expect(events).toHaveLength(0);
  });

  it('restores the exact console function identity after teardown', () => {
    // A bound copy would look the same but break identity comparisons and
    // stack a wrapper per HMR install/teardown cycle.
    const original = console.debug;
    const { sink } = createSink();
    teardown = installConsoleCollector(sink, context);
    expect(console.debug).not.toBe(original);

    teardown();
    teardown = undefined;
    expect(console.debug).toBe(original);
  });

  it('never breaks console when event building or the sink throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sink = {
      send: () => {
        throw new Error('sink exploded');
      },
    };
    teardown = installConsoleCollector(sink, context);

    expect(() => {
      console.error('app message');
    }).not.toThrow();
    // The app's own logging must still have gone through.
    expect(spy).toHaveBeenCalledWith('app message');
  });
});
