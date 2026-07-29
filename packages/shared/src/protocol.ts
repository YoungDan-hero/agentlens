/**
 * Wire protocol between the browser runtime SDK and the AgentLens daemon.
 *
 * All events form a discriminated union on the `type` field so that both
 * ends can narrow payloads without casting.
 */

export type AgentLensEventType = 'error' | 'console' | 'network' | 'lifecycle';

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

export interface NetworkEvent extends BaseEvent {
  type: 'network';
  method: string;
  requestUrl: string;
  /** HTTP status code, or null when the request failed at transport level. */
  status: number | null;
  durationMs: number;
  /** Stack captured at request initiation, used to attribute the caller. */
  initiatorStack: string | null;
  /** Source-mapped initiator frames, filled in by the daemon after ingest. */
  initiatorFrames: StackFrame[];
}

export interface LifecycleEvent extends BaseEvent {
  type: 'lifecycle';
  phase: 'load' | 'navigation' | 'hmr-update' | 'unload';
}

export type AgentLensEvent = ErrorEvent | ConsoleEvent | NetworkEvent | LifecycleEvent;

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

const EVENT_TYPES: readonly AgentLensEventType[] = ['error', 'console', 'network', 'lifecycle'];

function isEventType(value: unknown): value is AgentLensEventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value);
}

/** Runtime type guard validating data received at the daemon boundary. */
export function isAgentLensEvent(value: unknown): value is AgentLensEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<BaseEvent>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.timestamp === 'number' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.url === 'string' &&
    isEventType(candidate.type)
  );
}
