import { describe, expect, it } from 'vitest';

import type { ActionResult, SnapshotResponse } from './protocol';
import { isActionRequest, isActionResult, isSnapshotRequest, isSnapshotResponse } from './protocol';

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

describe('isActionRequest', () => {
  it('accepts a well-formed request', () => {
    expect(
      isActionRequest({
        kind: 'action-request',
        requestId: 'r1',
        action: 'click',
        target: { selector: '#go' },
      }),
    ).toBe(true);
  });

  it('rejects wrong kind, missing fields and non-objects', () => {
    expect(isActionRequest({ kind: 'action-result', requestId: 'r1', action: 'click' })).toBe(
      false,
    );
    expect(isActionRequest({ kind: 'action-request', action: 'click' })).toBe(false);
    expect(isActionRequest({ kind: 'action-request', requestId: 'r1' })).toBe(false);
    expect(isActionRequest(null)).toBe(false);
  });
});

describe('isActionResult', () => {
  const validResult: ActionResult = {
    kind: 'action-result',
    requestId: 'r1',
    sessionId: 'session-1',
    ok: true,
    error: null,
    target: { tag: 'button', id: 'go', text: 'Go', source: 'src/App.vue:3' },
    effects: { errors: 0, failedRequests: 0, consoleErrors: 0 },
    settledAfterMs: 120,
    settleTimedOut: false,
  };

  it('accepts success and failure shapes', () => {
    expect(isActionResult(validResult)).toBe(true);
    expect(
      isActionResult({ ...validResult, ok: false, error: 'no element matches', target: null }),
    ).toBe(true);
  });

  it('rejects missing or mistyped fields', () => {
    const { effects: _effects, ...withoutEffects } = validResult;
    expect(isActionResult(withoutEffects)).toBe(false);
    expect(isActionResult({ ...validResult, error: 42 })).toBe(false);
    expect(isActionResult({ ...validResult, settledAfterMs: 'fast' })).toBe(false);
    expect(isActionResult({ ...validResult, kind: 'action-request' })).toBe(false);
    expect(isActionResult(null)).toBe(false);
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
