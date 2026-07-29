import type {
  ConsoleEvent,
  ConsoleLevel,
  ErrorEvent,
  LifecycleEvent,
  NetworkEvent,
} from '@agentlens/shared';

export interface EventContext {
  sessionId: string;
  url: string;
}

function baseFields(
  context: EventContext,
): Pick<ErrorEvent, 'id' | 'timestamp' | 'sessionId' | 'url'> {
  return {
    id: crypto.randomUUID(),
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
    method: string;
    requestUrl: string;
    status: number | null;
    durationMs: number;
    initiatorStack: string | null;
  },
): NetworkEvent {
  return {
    ...baseFields(context),
    type: 'network',
    method: input.method,
    requestUrl: input.requestUrl,
    status: input.status,
    durationMs: input.durationMs,
    initiatorStack: input.initiatorStack,
    // Source-map resolution happens in the daemon; the browser ships raw stacks.
    initiatorFrames: [],
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
