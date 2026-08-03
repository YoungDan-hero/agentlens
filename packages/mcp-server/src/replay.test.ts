import { describe, expect, it } from 'vitest';

import type { ErrorEvent, InteractionEvent, InteractionTarget } from '@agentlensjs/shared';
import { buildReplayScript } from './replay';
import { EventStore } from './store';

let counter = 0;
const BASE = 1_720_000_000_000;

function makeError(timestamp: number): ErrorEvent {
  counter += 1;
  return {
    id: `error-${String(counter)}`,
    type: 'error',
    subtype: 'uncaught',
    timestamp,
    sessionId: 'session-1',
    url: 'http://localhost:5173/checkout',
    message: 'boom',
    stack: `Error: boom\n    at step${String(counter)} (http://localhost:5173/src/a.ts:1:1)`,
    frames: [],
    occurrences: 1,
  };
}

function makeInteraction(
  timestamp: number,
  subtype: 'click' | 'input' | 'submit',
  target: Partial<InteractionTarget> = {},
  synthetic?: boolean,
): InteractionEvent {
  counter += 1;
  return {
    id: `interaction-${String(counter)}`,
    type: 'interaction',
    subtype,
    timestamp,
    sessionId: 'session-1',
    url: 'http://localhost:5173/checkout',
    target: { tag: 'button', id: null, text: null, source: null, ...target },
    ...(synthetic !== undefined && { synthetic }),
  };
}

describe('buildReplayScript', () => {
  it('derives an executable script from the preceding interactions', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE + 100, 'input', { tag: 'input', id: 'email' }));
    store.add(makeInteraction(BASE + 200, 'click', { source: 'src/Checkout.vue:42', text: 'Pay' }));
    store.add(makeInteraction(BASE + 250, 'submit', { tag: 'form' }));
    const error = store.add(makeError(BASE + 300)) as ErrorEvent;

    const script = buildReplayScript(store, { errorId: error.id });
    if (!('steps' in script)) {
      throw new Error(`expected a script, got: ${script.error}`);
    }

    expect(script.steps).toEqual([
      { action: 'input', target: { selector: '[id="email"]' } },
      { action: 'click', target: { source: 'src/Checkout.vue:42' } },
    ]);
    expect(script.needsValue).toEqual([0]);
    expect(script.executable).toBe(true);
    expect(script.errorUrl).toBe('http://localhost:5173/checkout');
    // The submit was dropped as redundant with the click, and said so.
    expect(script.warnings.some((w) => w.includes('submit'))).toBe(true);
  });

  it('filters synthetic interactions and warns about them', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE + 50, 'click', { source: 'src/A.vue:1' }, true));
    store.add(makeInteraction(BASE + 100, 'click', { source: 'src/B.vue:2' }));
    const error = store.add(makeError(BASE + 200)) as ErrorEvent;

    const script = buildReplayScript(store, { errorId: error.id });
    if (!('steps' in script)) {
      throw new Error('expected a script');
    }

    expect(script.steps).toEqual([{ action: 'click', target: { source: 'src/B.vue:2' } }]);
    expect(script.warnings.some((w) => w.includes('synthetic'))).toBe(true);
  });

  it('strips the collector-added ellipsis from truncated text locators', () => {
    const store = new EventStore();
    // The interaction collector caps target text at 40 chars and appends
    // '…' — that character does not exist in the real DOM text, so the
    // replay locator must drop it or the substring match can never hit.
    store.add(
      makeInteraction(BASE + 100, 'click', {
        text: 'Confirm the order and proceed to paymen…',
      }),
    );
    const error = store.add(makeError(BASE + 200)) as ErrorEvent;

    const script = buildReplayScript(store, { errorId: error.id });
    if (!('steps' in script)) {
      throw new Error('expected a script');
    }

    expect(script.steps).toEqual([
      { action: 'click', target: { text: 'Confirm the order and proceed to paymen' } },
    ]);
    expect(script.executable).toBe(true);
  });

  it('reports load-time errors as having no replayable path', () => {
    const store = new EventStore();
    const error = store.add(makeError(BASE)) as ErrorEvent;

    const script = buildReplayScript(store, { errorId: error.id });
    expect('steps' in script).toBe(false);
    if (!('steps' in script)) {
      expect(script.error).toContain('No human interactions');
    }
  });

  it('marks the script non-executable when a target has no locator', () => {
    const store = new EventStore();
    store.add(makeInteraction(BASE + 50, 'click', { source: 'src/A.vue:1' }));
    // An anonymous element: no source, no id, no text.
    store.add(makeInteraction(BASE + 100, 'click', { tag: 'div' }));
    const error = store.add(makeError(BASE + 200)) as ErrorEvent;

    const script = buildReplayScript(store, { errorId: error.id });
    if (!('steps' in script)) {
      throw new Error('expected a script');
    }

    expect(script.executable).toBe(false);
    expect(script.steps).toHaveLength(1);
    expect(script.warnings.some((w) => w.includes('no usable locator'))).toBe(true);
  });

  it('propagates unknown-error failures from the context builder', () => {
    const script = buildReplayScript(new EventStore(), { errorId: 'missing' });
    expect('steps' in script).toBe(false);
    if (!('steps' in script)) {
      expect(script.error).toContain('No error matches');
    }
  });
});
