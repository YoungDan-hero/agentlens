import { describe, expect, it } from 'vitest';

import type { EventContext } from './events';
import { buildConsoleEvent, buildErrorEvent, serializeArg } from './events';

const context: EventContext = {
  sessionId: 'session-1',
  url: 'http://localhost:5173/',
};

describe('buildErrorEvent', () => {
  it('produces a valid error event with base fields', () => {
    const event = buildErrorEvent(context, {
      subtype: 'uncaught',
      message: 'boom',
      stack: 'Error: boom\n  at main.ts:1:1',
    });

    expect(event.type).toBe('error');
    expect(event.subtype).toBe('uncaught');
    expect(event.sessionId).toBe('session-1');
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event.timestamp).toBeTypeOf('number');
  });
});

describe('buildConsoleEvent', () => {
  it('serializes mixed arguments to strings', () => {
    const event = buildConsoleEvent(context, 'warn', ['msg', { a: 1 }, 42]);
    expect(event.args).toEqual(['msg', '{"a":1}', '42']);
  });
});

describe('serializeArg', () => {
  it('keeps plain strings as-is', () => {
    expect(serializeArg('hello')).toBe('hello');
  });

  it('serializes errors with their stack', () => {
    const error = new Error('oops');
    expect(serializeArg(error)).toContain('oops');
  });

  it('does not throw on circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeArg(circular)).toBe('[object Object]');
  });

  it('truncates oversized payloads', () => {
    const huge = 'x'.repeat(5000);
    expect(serializeArg(huge).length).toBeLessThanOrEqual(2001);
  });
});
