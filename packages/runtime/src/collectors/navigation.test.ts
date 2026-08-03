// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentLensEvent } from '@agentlensjs/shared';
import type { EventContext } from '../events';
import { installNavigationCollector } from './navigation';

const context: EventContext = {
  sessionId: 'session-1',
  get url() {
    return window.location.href;
  },
};

function makeSink(): { events: AgentLensEvent[]; send: (event: AgentLensEvent) => void } {
  const events: AgentLensEvent[] = [];
  return { events, send: (event) => events.push(event) };
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  history.replaceState(null, '', '/');
});

describe('installNavigationCollector', () => {
  it('reports pushState navigations with the new url', () => {
    const sink = makeSink();
    teardown = installNavigationCollector(sink, context);

    history.pushState(null, '', '/checkout');

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event?.type).toBe('lifecycle');
    if (event?.type === 'lifecycle') {
      expect(event.phase).toBe('navigation');
      expect(event.url).toContain('/checkout');
    }
  });

  it('reports replaceState and popstate, but not same-url updates', () => {
    const sink = makeSink();
    teardown = installNavigationCollector(sink, context);

    // State-only update on the current URL is not a navigation.
    history.pushState({ step: 1 }, '', window.location.href);
    expect(sink.events).toHaveLength(0);

    history.replaceState(null, '', '/settings');
    expect(sink.events).toHaveLength(1);

    history.replaceState(null, '', '/profile');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(sink.events).toHaveLength(2);
  });

  it('stops reporting after teardown while navigation keeps working', () => {
    const sink = makeSink();
    teardown = installNavigationCollector(sink, context);
    teardown();
    teardown = null;

    history.pushState(null, '', '/after-teardown');
    expect(window.location.pathname).toBe('/after-teardown');
    expect(sink.events).toHaveLength(0);
  });

  it('restores the exact history method identity after teardown', () => {
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const sink = makeSink();
    teardown = installNavigationCollector(sink, context);
    expect(history.pushState).not.toBe(originalPush);

    teardown();
    teardown = null;
    expect(history.pushState).toBe(originalPush);
    expect(history.replaceState).toBe(originalReplace);
  });

  it('never breaks pushState when reporting throws', () => {
    const sink = {
      send: () => {
        throw new Error('sink exploded');
      },
    };
    teardown = installNavigationCollector(sink, context);

    expect(() => {
      history.pushState(null, '', '/still-navigates');
    }).not.toThrow();
    expect(window.location.pathname).toBe('/still-navigates');
  });
});
