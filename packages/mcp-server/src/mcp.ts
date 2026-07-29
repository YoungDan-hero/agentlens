import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { EventStore } from './store';

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
export function createMcpServer(store: EventStore, version: string): McpServer {
  const server = new McpServer({ name: 'agentlens', version });

  server.registerTool(
    'get_page_health',
    {
      title: 'Get page health',
      description:
        'Overview of the running app: error count, failed requests and recent activity ' +
        'within the last 5 minutes. Call this first to decide where to drill down.',
    },
    () => jsonResult(store.summarize(DEFAULT_HEALTH_WINDOW_MS)),
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
          ...(args.sinceMs !== undefined && { sinceMs: args.sinceMs }),
          ...(args.limit !== undefined && { limit: args.limit }),
        }),
      ),
  );

  return server;
}
