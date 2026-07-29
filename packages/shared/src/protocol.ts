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
