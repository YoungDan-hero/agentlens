/**
 * Deep validation of wire events at the ingest boundary.
 *
 * The shared package ships lightweight guards suitable for the browser
 * bundle; the daemon is the trust boundary, so here every subtype payload
 * is validated field-by-field before it can reach the store (and, through
 * MCP tools, an AI agent's context).
 */
import { z } from 'zod';

import type { AgentLensEvent } from '@agentlensjs/shared';

const stackFrameSchema = z.object({
  functionName: z.string().nullable(),
  fileName: z.string().nullable(),
  line: z.number().nullable(),
  column: z.number().nullable(),
});

const baseFields = {
  id: z.string(),
  timestamp: z.number(),
  sessionId: z.string(),
  url: z.string(),
};

const errorEventSchema = z.object({
  ...baseFields,
  type: z.literal('error'),
  subtype: z.enum(['uncaught', 'unhandledrejection']),
  message: z.string(),
  stack: z.string().nullable(),
  frames: z.array(stackFrameSchema),
  occurrences: z.number(),
  fingerprint: z.string().optional(),
});

const consoleEventSchema = z.object({
  ...baseFields,
  type: z.literal('console'),
  level: z.enum(['log', 'info', 'warn', 'error', 'debug']),
  args: z.array(z.string()),
});

const networkEventSchema = z.object({
  ...baseFields,
  type: z.literal('network'),
  transport: z.enum(['fetch', 'xhr', 'websocket', 'beacon']),
  method: z.string(),
  requestUrl: z.string(),
  status: z.number().nullable(),
  durationMs: z.number(),
  initiatorStack: z.string().nullable(),
  initiatorFrames: z.array(stackFrameSchema),
  requestBody: z.string().nullable(),
  responseBody: z.string().nullable(),
});

const lifecycleEventSchema = z.object({
  ...baseFields,
  type: z.literal('lifecycle'),
  phase: z.enum(['load', 'navigation', 'hmr-update', 'unload']),
});

const interactionEventSchema = z.object({
  ...baseFields,
  type: z.literal('interaction'),
  subtype: z.enum(['click', 'input', 'submit']),
  target: z.object({
    tag: z.string(),
    id: z.string().nullable(),
    text: z.string().nullable(),
    source: z.string().nullable(),
  }),
  synthetic: z.boolean().optional(),
});

const performanceEventSchema = z.object({
  ...baseFields,
  type: z.literal('performance'),
  metric: z.enum(['FCP', 'LCP', 'CLS', 'INP', 'TTFB', 'long-task']),
  value: z.number(),
  rating: z.enum(['good', 'needs-improvement', 'poor']).nullable(),
  detail: z.string().nullable(),
});

const eventSchema = z.discriminatedUnion('type', [
  errorEventSchema,
  consoleEventSchema,
  networkEventSchema,
  lifecycleEventSchema,
  interactionEventSchema,
  performanceEventSchema,
]);

/**
 * Compile-time drift guard: if a schema stops matching the protocol type
 * (missing field, wrong type), this function fails to typecheck. The error
 * branch rebuilds the object because zod's `.optional()` infers
 * `string | undefined`, which `exactOptionalPropertyTypes` keeps apart
 * from the protocol's `fingerprint?: string`.
 */
function toProtocolEvent(event: z.infer<typeof eventSchema>): AgentLensEvent {
  if (event.type === 'error') {
    const { fingerprint, ...rest } = event;
    return fingerprint === undefined ? rest : { ...rest, fingerprint };
  }
  if (event.type === 'interaction') {
    const { synthetic, ...rest } = event;
    return synthetic === undefined ? rest : { ...rest, synthetic };
  }
  return event;
}

/** Deep-validates one wire event. Returns null for malformed payloads. */
export function parseEvent(value: unknown): AgentLensEvent | null {
  const result = eventSchema.safeParse(value);
  return result.success ? toProtocolEvent(result.data) : null;
}
