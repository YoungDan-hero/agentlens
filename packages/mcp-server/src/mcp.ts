import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { EventStore } from './store';
import { verifyFix } from './verify-fix';
import type { WsIngestServer } from './ws-server';

const DEFAULT_HEALTH_WINDOW_MS = 5 * 60 * 1000;

interface TextResult {
  content: { type: 'text'; text: string }[];
  [key: string]: unknown;
}

function jsonResult(payload: unknown): TextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Exposes the event store to AI agents. Tools are designed around an agent's
 * debugging workflow: a cheap health overview first, then targeted drill-down.
 */
export function createMcpServer(
  store: EventStore,
  version: string,
  ingest?: Pick<WsIngestServer, 'requestSnapshot'>,
): McpServer {
  const server = new McpServer({ name: 'agentlens', version });

  server.registerTool(
    'get_page_health',
    {
      title: 'Get page health',
      description:
        'Overview of the running app: distinct errors (with folded occurrence counts), ' +
        'failed requests and recent activity within the last 5 minutes. Scoped to the ' +
        'most recently active page session unless sessionId is given. Call this first ' +
        'to decide where to drill down.',
      inputSchema: {
        sessionId: z.string().optional().describe('Scope to a specific page session'),
      },
    },
    (args) => jsonResult(store.summarize(DEFAULT_HEALTH_WINDOW_MS, args.sessionId)),
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List page sessions',
      description:
        'Lists known page sessions (one per page load / tab), most recently active ' +
        'first. Use the sessionId to scope other tools when multiple pages are open.',
    },
    () => jsonResult(store.listSessions()),
  );

  server.registerTool(
    'get_recent_events',
    {
      title: 'Get recent events',
      description:
        'Query captured runtime events (errors, console output, network requests, ' +
        'lifecycle), newest first. Filter by type and time to keep responses small.',
      inputSchema: {
        type: z.enum(['error', 'console', 'network', 'lifecycle']).optional(),
        sessionId: z.string().optional().describe('Only events from this page session'),
        sinceMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only events newer than this epoch-milliseconds timestamp'),
        limit: z.number().int().min(1).max(200).optional().describe('Defaults to 50'),
      },
    },
    (args) =>
      jsonResult(
        store.query({
          ...(args.type !== undefined && { type: args.type }),
          ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
          ...(args.sinceMs !== undefined && { sinceMs: args.sinceMs }),
          ...(args.limit !== undefined && { limit: args.limit }),
        }),
      ),
  );

  server.registerTool(
    'verify_fix',
    {
      title: 'Verify a fix',
      description:
        'Closes the loop after editing code: waits for the new code to reach the ' +
        'browser (HMR update or reload), then watches whether the given error ' +
        'fingerprint recurs. Take the fingerprint from get_recent_events or ' +
        'get_page_health. Blocks up to timeoutMs + quietWindowMs.',
      inputSchema: {
        fingerprint: z.string().min(1).describe('Fingerprint of the error to verify'),
        timeoutMs: z
          .number()
          .int()
          .min(500)
          .max(60_000)
          .optional()
          .describe('Max wait for the code update to arrive. Defaults to 10000.'),
        quietWindowMs: z
          .number()
          .int()
          .min(500)
          .max(30_000)
          .optional()
          .describe('Recurrence observation window after the update. Defaults to 3000.'),
      },
    },
    async (args) =>
      jsonResult(
        await verifyFix(store, args.fingerprint, {
          ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
          ...(args.quietWindowMs !== undefined && { quietWindowMs: args.quietWindowMs }),
        }),
      ),
  );

  if (ingest) {
    server.registerTool(
      'get_layout_snapshot',
      {
        title: 'Get layout snapshot',
        description:
          'Captures a live structured layout tree of the running page: every visible ' +
          'element with its box (viewport rect), visibility, overflow state, direct text ' +
          'and — where available — the source location that rendered it ' +
          '(data-agentlens-source, "file:line"). Use it to reason about layout and ' +
          'styling issues without a screenshot, and to locate the code behind any box.',
        inputSchema: {
          sessionId: z
            .string()
            .optional()
            .describe('Target a specific page session; defaults to the most active one'),
        },
      },
      async (args) => {
        try {
          return jsonResult(await ingest.requestSnapshot(args.sessionId));
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
  }

  return server;
}
