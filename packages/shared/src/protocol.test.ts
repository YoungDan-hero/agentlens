import { describe, expect, it } from 'vitest';

import type { SnapshotResponse } from './protocol';
import { isSnapshotRequest, isSnapshotResponse } from './protocol';

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
