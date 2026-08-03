import { describe, expect, it } from 'vitest';

import type { ActionResult, FocusUpdate, SnapshotResponse } from './protocol';
import {
  isActionRequest,
  isActionResult,
  isActionSequenceRequest,
  isActionSequenceResult,
  isFocusUpdate,
  isSnapshotRequest,
  isSnapshotResponse,
  isSourceQueryRequest,
  isSourceQueryResponse,
} from './protocol';

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

describe('isActionSequenceRequest / isActionSequenceResult', () => {
  it('accepts well-formed messages', () => {
    expect(
      isActionSequenceRequest({
        kind: 'action-sequence-request',
        requestId: 'r1',
        steps: [{ action: 'click', target: { selector: '#go' } }],
      }),
    ).toBe(true);
    expect(
      isActionSequenceResult({
        kind: 'action-sequence-result',
        requestId: 'r1',
        sessionId: 's1',
        ok: false,
        stoppedAt: 1,
        stopReason: 'boom',
        stepResults: [],
        totalEffects: { errors: 0, failedRequests: 0, consoleErrors: 0 },
        finalUrl: 'http://localhost:5173/',
      }),
    ).toBe(true);
  });

  it('rejects missing fields and non-objects', () => {
    expect(isActionSequenceRequest({ kind: 'action-sequence-request', requestId: 'r1' })).toBe(
      false,
    );
    expect(
      isActionSequenceResult({
        kind: 'action-sequence-result',
        requestId: 'r1',
        sessionId: 's1',
        ok: true,
        stoppedAt: null,
        stopReason: null,
        stepResults: [],
        totalEffects: null,
        finalUrl: 'u',
      }),
    ).toBe(false);
    expect(isActionSequenceRequest(null)).toBe(false);
  });
});

describe('isSourceQueryRequest / isSourceQueryResponse', () => {
  it('accepts well-formed messages', () => {
    expect(
      isSourceQueryRequest({
        kind: 'source-query-request',
        requestId: 'r1',
        source: 'src/App.vue',
      }),
    ).toBe(true);
    expect(
      isSourceQueryResponse({
        kind: 'source-query-response',
        requestId: 'r1',
        sessionId: 's1',
        url: 'http://localhost:5173/',
        capturedAt: 1,
        elements: [],
        truncated: false,
      }),
    ).toBe(true);
  });

  it('rejects missing fields and non-objects', () => {
    expect(isSourceQueryRequest({ kind: 'source-query-request', requestId: 'r1' })).toBe(false);
    expect(
      isSourceQueryResponse({
        kind: 'source-query-response',
        requestId: 'r1',
        sessionId: 's1',
        url: 'u',
        capturedAt: 1,
        elements: 'nope',
        truncated: false,
      }),
    ).toBe(false);
    expect(isSourceQueryRequest(null)).toBe(false);
  });
});

describe('isFocusUpdate', () => {
  const valid: FocusUpdate = {
    kind: 'focus-update',
    sessionId: 'session-1',
    visible: true,
    focused: false,
    url: 'http://localhost:5173/',
    at: 1720000000000,
  };

  it('accepts a well-formed update', () => {
    expect(isFocusUpdate(valid)).toBe(true);
  });

  it('rejects wrong kind, missing or mistyped fields and non-objects', () => {
    expect(isFocusUpdate({ ...valid, kind: 'action-result' })).toBe(false);
    expect(isFocusUpdate({ ...valid, visible: 'yes' })).toBe(false);
    expect(isFocusUpdate({ ...valid, sessionId: undefined })).toBe(false);
    expect(isFocusUpdate({ ...valid, at: 'now' })).toBe(false);
    expect(isFocusUpdate(null)).toBe(false);
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
