import { describe, expect, it } from 'vitest';

import type { AgentLensEvent } from '@agentlensjs/shared';

import { parseEvent } from './validate';

const base = {
  id: 'e1',
  timestamp: 1000,
  sessionId: 's1',
  url: 'http://localhost:5173/',
};

const validError: AgentLensEvent = {
  ...base,
  type: 'error',
  subtype: 'uncaught',
  message: 'boom',
  stack: null,
  frames: [],
  occurrences: 1,
};

describe('parseEvent', () => {
  it('accepts every valid event subtype', () => {
    const events: AgentLensEvent[] = [
      validError,
      { ...base, type: 'console', level: 'warn', args: ['a'] },
      {
        ...base,
        type: 'network',
        transport: 'fetch',
        method: 'GET',
        requestUrl: '/api',
        status: 200,
        durationMs: 12,
        initiatorStack: null,
        initiatorFrames: [],
        requestBody: null,
        responseBody: null,
      },
      { ...base, type: 'lifecycle', phase: 'load' },
      {
        ...base,
        type: 'interaction',
        subtype: 'click',
        target: { tag: 'button', id: 'save', text: 'Save', source: 'src/App.tsx:1' },
      },
      { ...base, type: 'performance', metric: 'LCP', value: 1200, rating: 'good', detail: null },
    ];
    for (const event of events) {
      expect(parseEvent(event), `subtype ${event.type}`).toEqual(event);
    }
  });

  it('rejects events missing subtype payload fields', () => {
    // Passes the shallow base check but has no error payload — the exact
    // gap the deep validation exists to close.
    expect(parseEvent({ ...base, type: 'error' })).toBeNull();
    expect(parseEvent({ ...base, type: 'console', level: 'warn' })).toBeNull();
  });

  it('rejects wrong field types within a payload', () => {
    expect(parseEvent({ ...validError, occurrences: 'many' })).toBeNull();
    expect(parseEvent({ ...validError, frames: [{ functionName: 1 }] })).toBeNull();
  });

  it('rejects unknown types and non-objects', () => {
    expect(parseEvent({ ...base, type: 'telemetry' })).toBeNull();
    expect(parseEvent('error')).toBeNull();
    expect(parseEvent(null)).toBeNull();
  });

  it('strips unknown extra keys instead of storing them', () => {
    const parsed = parseEvent({ ...validError, __proto_pollution: 'x' });
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(validError);
  });
});
