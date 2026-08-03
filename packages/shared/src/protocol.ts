/**
 * Wire protocol between the browser runtime SDK and the AgentLens daemon.
 *
 * All events form a discriminated union on the `type` field so that both
 * ends can narrow payloads without casting.
 */

export type AgentLensEventType =
  'error' | 'console' | 'network' | 'lifecycle' | 'interaction' | 'performance';

export interface BaseEvent {
  /** Unique event id (UUID v4). */
  id: string;
  type: AgentLensEventType;
  /** Epoch milliseconds when the event occurred in the browser. */
  timestamp: number;
  /** Identifies one page session (survives HMR, reset on full reload). */
  sessionId: string;
  /** Page URL at the time of the event. */
  url: string;
}

/** A single frame of a (possibly source-mapped) stack trace. */
export interface StackFrame {
  functionName: string | null;
  fileName: string | null;
  line: number | null;
  column: number | null;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  subtype: 'uncaught' | 'unhandledrejection';
  message: string;
  /** Raw stack string as thrown in the browser (before source-map resolution). */
  stack: string | null;
  frames: StackFrame[];
  /**
   * How many times this identical error occurred. The browser always sends 1;
   * the daemon folds repeats (same fingerprint) into one record and counts.
   */
  occurrences: number;
  /**
   * Stable identity of this error (daemon-assigned at ingest). Pass it to
   * the `verify_fix` tool to check whether a fix made the error go away.
   */
  fingerprint?: string;
}

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEvent extends BaseEvent {
  type: 'console';
  level: ConsoleLevel;
  /** Arguments serialized to safe string representations. */
  args: string[];
}

/** Which API the request went through. */
export type NetworkTransport = 'fetch' | 'xhr' | 'websocket' | 'beacon';

export interface NetworkEvent extends BaseEvent {
  type: 'network';
  transport: NetworkTransport;
  method: string;
  /** Request URL with sensitive query parameter values redacted. */
  requestUrl: string;
  /**
   * HTTP status code. Null when no response is observable: transport-level
   * failures, `sendBeacon` (fire-and-forget) and failed WebSocket upgrades.
   */
  status: number | null;
  /** For WebSocket connections this is the time until the socket opened. */
  durationMs: number;
  /** Stack captured at request initiation, used to attribute the caller. */
  initiatorStack: string | null;
  /** Source-mapped initiator frames, filled in by the daemon after ingest. */
  initiatorFrames: StackFrame[];
  /**
   * Request body, redacted and truncated. Only populated when the runtime
   * runs with `captureBodies: true`; always null otherwise.
   */
  requestBody: string | null;
  /** Response body, redacted and truncated. Same opt-in as `requestBody`. */
  responseBody: string | null;
}

export interface LifecycleEvent extends BaseEvent {
  type: 'lifecycle';
  phase: 'load' | 'navigation' | 'hmr-update' | 'unload';
}

/** Compact description of the element a user interacted with. */
export interface InteractionTarget {
  tag: string;
  id: string | null;
  /** Visible text of the element, trimmed and truncated. */
  text: string | null;
  /** Source attribution (`file:line`) of the element or its nearest tagged ancestor. */
  source: string | null;
}

export interface InteractionEvent extends BaseEvent {
  type: 'interaction';
  subtype: 'click' | 'input' | 'submit';
  target: InteractionTarget;
  /**
   * True when the interaction was synthesized by the AgentLens action
   * channel rather than performed by a human (`isTrusted` was false).
   * Doubles as the audit trail of everything an agent did to the page.
   */
  synthetic?: boolean;
}

/**
 * Web Vitals plus long tasks. Time-based metrics are milliseconds;
 * CLS is the unitless cumulative layout shift score.
 */
export type PerformanceMetric = 'FCP' | 'LCP' | 'CLS' | 'INP' | 'TTFB' | 'long-task';

export type PerformanceRating = 'good' | 'needs-improvement' | 'poor';

export interface PerformanceEvent extends BaseEvent {
  type: 'performance';
  metric: PerformanceMetric;
  value: number;
  /** Web-Vitals threshold rating. Null for metrics without one (long tasks). */
  rating: PerformanceRating | null;
  /** Extra attribution, e.g. the culprit container of a long task. */
  detail: string | null;
}

export type AgentLensEvent =
  ErrorEvent | ConsoleEvent | NetworkEvent | LifecycleEvent | InteractionEvent | PerformanceEvent;

/** Envelope sent over the WebSocket connection. */
export interface ProtocolMessage {
  protocolVersion: number;
  events: AgentLensEvent[];
}

/** One element in a structured layout snapshot of the page. */
export interface LayoutNode {
  tag: string;
  /** Source attribution injected by the Vite plugin (`file:line`), if any. */
  source: string | null;
  /** Viewport-relative box, rounded to integers. */
  rect: { x: number; y: number; width: number; height: number };
  /** False when hidden via display/visibility or zero-sized. */
  visible: boolean;
  /** True when content overflows the element's box. */
  overflow: boolean;
  /** Direct text content of this element, trimmed and truncated. */
  text: string | null;
  children: LayoutNode[];
}

/** Daemon -> browser: asks the runtime to capture a layout snapshot. */
export interface SnapshotRequest {
  kind: 'snapshot-request';
  requestId: string;
}

/** Browser -> daemon: the captured snapshot. */
export interface SnapshotResponse {
  kind: 'snapshot-response';
  requestId: string;
  sessionId: string;
  url: string;
  capturedAt: number;
  /** Null when the document has no body. */
  root: LayoutNode | null;
  /** True when the node budget was exhausted and subtrees were dropped. */
  truncated: boolean;
}

/**
 * Browser -> daemon: reports whether the page is the one the user is
 * currently looking at. The daemon prefers focused, visible sessions when
 * choosing which page to snapshot or act on, so agent actions land on the
 * page in front of the user instead of a background tab.
 */
export interface FocusUpdate {
  kind: 'focus-update';
  sessionId: string;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** `document.hasFocus()` — false when the user is in another window. */
  focused: boolean;
  url: string;
  at: number;
}

export function isFocusUpdate(value: unknown): value is FocusUpdate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<FocusUpdate>;
  return (
    candidate.kind === 'focus-update' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.visible === 'boolean' &&
    typeof candidate.focused === 'boolean' &&
    typeof candidate.url === 'string' &&
    typeof candidate.at === 'number'
  );
}

/** Daemon -> browser: asks which elements a source file renders right now. */
export interface SourceQueryRequest {
  kind: 'source-query-request';
  requestId: string;
  /** File path (`src/App.vue`) or exact attribution (`src/App.vue:42`). */
  source: string;
}

/** Compact description of one element found by a source query. */
export interface SourceElementSummary {
  tag: string;
  id: string | null;
  /** Visible text, trimmed and truncated. */
  text: string | null;
  /** False when hidden via display/visibility. */
  visible: boolean;
  /** The element's exact `data-agentlens-source` value (`file:line`). */
  source: string;
}

/** Browser -> daemon: the elements currently rendered by the queried source. */
export interface SourceQueryResponse {
  kind: 'source-query-response';
  requestId: string;
  sessionId: string;
  url: string;
  capturedAt: number;
  elements: SourceElementSummary[];
  /** True when the element budget was exhausted. */
  truncated: boolean;
}

export function isSourceQueryRequest(value: unknown): value is SourceQueryRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SourceQueryRequest>;
  return (
    candidate.kind === 'source-query-request' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.source === 'string'
  );
}

export function isSourceQueryResponse(value: unknown): value is SourceQueryResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SourceQueryResponse>;
  return (
    candidate.kind === 'source-query-response' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.url === 'string' &&
    typeof candidate.capturedAt === 'number' &&
    typeof candidate.truncated === 'boolean' &&
    Array.isArray(candidate.elements)
  );
}

/** Kinds of page actions the daemon can ask the runtime to perform. */
export type ActionType = 'click' | 'input' | 'select' | 'scroll' | 'navigate';

/**
 * Locates the element an action applies to. Exactly one of the locator
 * fields is used, in priority order: `source` (stable across refactors) →
 * `selector` → `text` (deepest element whose visible text contains it).
 */
export interface ActionTarget {
  /** `data-agentlens-source` value, e.g. `"src/App.vue:42"`. */
  source?: string;
  /** CSS selector. */
  selector?: string;
  /** Visible text to match (trimmed, case-sensitive substring). */
  text?: string;
  /** Zero-based index when the locator matches multiple elements. */
  nth?: number;
}

/** Daemon -> browser: asks the runtime to perform one page action. */
export interface ActionRequest {
  kind: 'action-request';
  requestId: string;
  action: ActionType;
  /** Required for click / input / select; optional for scroll. */
  target?: ActionTarget;
  /** The value to type (input) or the option value/label to pick (select). */
  value?: string;
  /** Same-origin URL or path to navigate to. */
  url?: string;
  /** Viewport scroll coordinates when `scroll` has no target. */
  x?: number;
  y?: number;
}

/** Signals captured between dispatching an action and the page settling. */
export interface ActionEffects {
  errors: number;
  failedRequests: number;
  consoleErrors: number;
}

/** Outcome of one executed action, shared by single and sequence results. */
export interface ActionOutcome {
  ok: boolean;
  /** Failure reason; null on success. */
  error: string | null;
  /** The element actually acted on; null on failure or element-less actions. */
  target: InteractionTarget | null;
  effects: ActionEffects;
  /** Milliseconds until the page went quiet after the action. */
  settledAfterMs: number;
  /** True when the settle wait hit its ceiling instead of going quiet. */
  settleTimedOut: boolean;
}

/** Browser -> daemon: outcome of one action request. */
export interface ActionResult extends ActionOutcome {
  kind: 'action-result';
  requestId: string;
  sessionId: string;
}

/**
 * A condition a sequence step waits for before executing — how scripted
 * sequences ride out async UI (options loading, conditional fields
 * appearing) without a round-trip to the agent.
 */
export interface WaitCondition {
  /** Locate awaited element(s) by `data-agentlens-source` value. */
  source?: string;
  /** Locate by CSS selector. */
  selector?: string;
  /** Locate by visible text (substring). */
  text?: string;
  /**
   * `visible` (default): at least one match is rendered and not hidden.
   * `attached`: at least one match exists in the DOM, hidden or not.
   * `hidden`: no match exists, or every match is hidden.
   */
  state?: 'visible' | 'attached' | 'hidden';
  /** Give up after this long. @default 5000 */
  timeoutMs?: number;
}

/** One step of an action sequence. */
export interface ActionStep {
  action: ActionType;
  target?: ActionTarget;
  value?: string;
  url?: string;
  x?: number;
  y?: number;
  /** Condition to await before executing this step. */
  waitFor?: WaitCondition;
}

/** Hard cap on sequence length, enforced on both ends of the wire. */
export const MAX_SEQUENCE_STEPS = 20;

/** Daemon -> browser: asks the runtime to run several actions in order. */
export interface ActionSequenceRequest {
  kind: 'action-sequence-request';
  requestId: string;
  steps: ActionStep[];
}

/** Browser -> daemon: outcome of a sequence, including the break point. */
export interface ActionSequenceResult {
  kind: 'action-sequence-result';
  requestId: string;
  sessionId: string;
  /** True when every step ran and succeeded. */
  ok: boolean;
  /**
   * Index of the step the sequence stopped at. Null when all steps ran —
   * but also for structural refusals (empty/oversized sequence, misplaced
   * navigate) that never start; those carry a stopReason and ok: false.
   */
  stoppedAt: number | null;
  /** Why the sequence stopped early; null when all steps ran. */
  stopReason: string | null;
  /** Per-step outcomes for the steps that were attempted. */
  stepResults: ActionOutcome[];
  /** Effects accumulated across all attempted steps. */
  totalEffects: ActionEffects;
  /** Page URL (redacted) after the sequence finished or stopped. */
  finalUrl: string;
}

export function isActionRequest(value: unknown): value is ActionRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ActionRequest>;
  return (
    candidate.kind === 'action-request' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.action === 'string'
  );
}

export function isActionResult(value: unknown): value is ActionResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ActionResult>;
  // Read untyped: the wire value may carry anything, including null.
  const effects: unknown = (value as { effects?: unknown }).effects;
  const target: unknown = (value as { target?: unknown }).target;
  return (
    candidate.kind === 'action-result' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.ok === 'boolean' &&
    typeof candidate.settledAfterMs === 'number' &&
    typeof candidate.settleTimedOut === 'boolean' &&
    (candidate.error === null || typeof candidate.error === 'string') &&
    (target === null || typeof target === 'object') &&
    typeof effects === 'object' &&
    effects !== null
  );
}

export function isActionSequenceRequest(value: unknown): value is ActionSequenceRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ActionSequenceRequest>;
  return (
    candidate.kind === 'action-sequence-request' &&
    typeof candidate.requestId === 'string' &&
    Array.isArray(candidate.steps)
  );
}

export function isActionSequenceResult(value: unknown): value is ActionSequenceResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ActionSequenceResult>;
  const totalEffects: unknown = (value as { totalEffects?: unknown }).totalEffects;
  return (
    candidate.kind === 'action-sequence-result' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.ok === 'boolean' &&
    (candidate.stoppedAt === null || typeof candidate.stoppedAt === 'number') &&
    (candidate.stopReason === null || typeof candidate.stopReason === 'string') &&
    Array.isArray(candidate.stepResults) &&
    typeof candidate.finalUrl === 'string' &&
    typeof totalEffects === 'object' &&
    totalEffects !== null
  );
}

export function isSnapshotRequest(value: unknown): value is SnapshotRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SnapshotRequest>;
  return candidate.kind === 'snapshot-request' && typeof candidate.requestId === 'string';
}

export function isSnapshotResponse(value: unknown): value is SnapshotResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SnapshotResponse>;
  return (
    candidate.kind === 'snapshot-response' &&
    typeof candidate.requestId === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.url === 'string' &&
    typeof candidate.capturedAt === 'number' &&
    typeof candidate.truncated === 'boolean' &&
    (candidate.root === null || typeof candidate.root === 'object')
  );
}
