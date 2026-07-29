import { describe, expect, it } from 'vitest';

import type { ErrorEvent, SnapshotResponse } from './protocol';
import { isAgentLensEvent, isSnapshotRequest, isSnapshotResponse } from './protocol';

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
  occurrences: 1,
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

describe('isSnapshotRequest', () => {
  it('accepts a well-formed request', () => {
    expect(isSnapshotRequest({ kind: 'snapshot-request', requestId: 'r1' })).toBe(true);
  });

  it('rejects wrong kind, missing requestId and non-objects', () => {
    expect(isSnapshotRequest({ kind: 'snapshot-response', requestId: 'r1' })).toBe(false);
    expect(isSnapshotRequest({ kind: 'snapshot-request' })).toBe(false);
    expect(isSnapshotRequest(null)).toBe(false);
    expect(isSnapshotRequest('snapshot-request')).toBe(false);
  });
});

describe('isSnapshotResponse', () => {
  const validResponse: SnapshotResponse = {
    kind: 'snapshot-response',
    requestId: 'r1',
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    capturedAt: Date.now(),
    root: null,
    truncated: false,
  };

  it('accepts a well-formed response, including a null root', () => {
    expect(isSnapshotResponse(validResponse)).toBe(true);
  });

  it('rejects responses with missing or mistyped fields', () => {
    const { sessionId: _sessionId, ...withoutSession } = validResponse;
    expect(isSnapshotResponse(withoutSession)).toBe(false);
    expect(isSnapshotResponse({ ...validResponse, capturedAt: 'now' })).toBe(false);
    expect(isSnapshotResponse({ ...validResponse, kind: 'snapshot-request' })).toBe(false);
    expect(isSnapshotResponse(null)).toBe(false);
  });
});
