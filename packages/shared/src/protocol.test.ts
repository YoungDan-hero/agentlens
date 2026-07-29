import { describe, expect, it } from 'vitest';

import type { ErrorEvent } from './protocol';
import { isAgentLensEvent } from './protocol';

const validEvent: ErrorEvent = {
  id: '5f0c1a1e-0000-4000-8000-000000000000',
  type: 'error',
  subtype: 'uncaught',
  timestamp: Date.now(),
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
  message: 'boom',
  stack: null,
  frames: [],
};

describe('isAgentLensEvent', () => {
  it('accepts a well-formed event', () => {
    expect(isAgentLensEvent(validEvent)).toBe(true);
  });

  it('rejects primitives and null', () => {
    expect(isAgentLensEvent(null)).toBe(false);
    expect(isAgentLensEvent('error')).toBe(false);
    expect(isAgentLensEvent(42)).toBe(false);
  });

  it('rejects objects with an unknown type', () => {
    expect(isAgentLensEvent({ ...validEvent, type: 'unknown' })).toBe(false);
  });

  it('rejects objects missing required base fields', () => {
    const { sessionId: _sessionId, ...withoutSession } = validEvent;
    expect(isAgentLensEvent(withoutSession)).toBe(false);
  });
});
