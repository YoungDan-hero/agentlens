import type {
  ConsoleEvent,
  ConsoleLevel,
  ErrorEvent,
  InteractionEvent,
  InteractionTarget,
  LifecycleEvent,
  NetworkEvent,
  NetworkTransport,
  PerformanceEvent,
  PerformanceMetric,
  PerformanceRating,
} from '@agentlensjs/shared';

import { redactUrl } from './redact';
import { generateId } from './uuid';

export interface EventContext {
  sessionId: string;
  url: string;
}

function baseFields(
  context: EventContext,
): Pick<ErrorEvent, 'id' | 'timestamp' | 'sessionId' | 'url'> {
  return {
    id: generateId(),
    timestamp: Date.now(),
    sessionId: context.sessionId,
    url: context.url,
  };
}

export function buildErrorEvent(
  context: EventContext,
  input: {
    subtype: ErrorEvent['subtype'];
    message: string;
    stack: string | null;
  },
): ErrorEvent {
  return {
    ...baseFields(context),
    type: 'error',
    subtype: input.subtype,
    message: input.message,
    stack: input.stack,
    // Source-map resolution happens in the daemon; the browser ships raw frames.
    frames: [],
    occurrences: 1,
  };
}

export function buildConsoleEvent(
  context: EventContext,
  level: ConsoleLevel,
  args: readonly unknown[],
): ConsoleEvent {
  return {
    ...baseFields(context),
    type: 'console',
    level,
    args: args.map(serializeArg),
  };
}

export function buildNetworkEvent(
  context: EventContext,
  input: {
    transport: NetworkTransport;
    method: string;
    requestUrl: string;
    status: number | null;
    durationMs: number;
    initiatorStack: string | null;
    requestBody?: string | null;
    responseBody?: string | null;
  },
): NetworkEvent {
  return {
    ...baseFields(context),
    type: 'network',
    transport: input.transport,
    method: input.method,
    // Centralized here so every transport gets query-parameter redaction.
    requestUrl: redactUrl(input.requestUrl),
    status: input.status,
    durationMs: input.durationMs,
    initiatorStack: input.initiatorStack,
    // Source-map resolution happens in the daemon; the browser ships raw stacks.
    initiatorFrames: [],
    requestBody: input.requestBody ?? null,
    responseBody: input.responseBody ?? null,
  };
}

export function buildPerformanceEvent(
  context: EventContext,
  input: {
    metric: PerformanceMetric;
    value: number;
    rating: PerformanceRating | null;
    detail?: string | null;
  },
): PerformanceEvent {
  return {
    ...baseFields(context),
    type: 'performance',
    metric: input.metric,
    value: input.value,
    rating: input.rating,
    detail: input.detail ?? null,
  };
}

export function buildInteractionEvent(
  context: EventContext,
  subtype: InteractionEvent['subtype'],
  target: InteractionTarget,
): InteractionEvent {
  return {
    ...baseFields(context),
    type: 'interaction',
    subtype,
    target,
  };
}

export function buildLifecycleEvent(
  context: EventContext,
  phase: LifecycleEvent['phase'],
): LifecycleEvent {
  return {
    ...baseFields(context),
    type: 'lifecycle',
    phase,
  };
}

const MAX_ARG_LENGTH = 2000;

// JSON.stringify's lib typing hides that it yields undefined for symbols,
// functions and bare undefined; re-typing it keeps the fallback reachable.
const stringify: (value: unknown) => string | undefined = JSON.stringify;

/** Serializes an arbitrary console argument into a bounded, safe string. */
export function serializeArg(value: unknown): string {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else if (value instanceof Error) {
    text = value.stack ?? `${value.name}: ${value.message}`;
  } else {
    try {
      text = stringify(value) ?? String(value);
    } catch {
      // Circular structures and exotic objects fall back to their tag.
      text = Object.prototype.toString.call(value);
    }
  }
  return text.length > MAX_ARG_LENGTH ? `${text.slice(0, MAX_ARG_LENGTH)}…` : text;
}
