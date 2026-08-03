import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { EventStore } from './store';
import { buildErrorContext } from './error-context';
import { summarizePerformance } from './performance-summary';
import { buildTimeline } from './timeline';
import { verifyFix } from './verify-fix';
import { waitForIdle } from './wait-for-idle';
import type { ActionCommand, WsIngestServer } from './ws-server';

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
  ingest?: Pick<WsIngestServer, 'requestSnapshot' | 'requestAction'>,
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
        'lifecycle, performance), newest first. Filter by type and time to keep ' +
        'responses small.',
      inputSchema: {
        type: z
          .enum(['error', 'console', 'network', 'lifecycle', 'interaction', 'performance'])
          .optional(),
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
    'get_interaction_timeline',
    {
      title: 'Get interaction timeline',
      description:
        'Cause-and-effect view of recent activity: user interactions (clicks, inputs, ' +
        'submits — each with the source location of the element) grouped with the ' +
        'errors, requests and logs they triggered. Use this to answer "what did the ' +
        'user do to cause this error?". Events outside any interaction window appear ' +
        'under "background".',
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe('Scope to a page session; defaults to the most recently active one'),
        sinceMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only consider events newer than this epoch-milliseconds timestamp'),
        windowMs: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .optional()
          .describe('Attribution window after each interaction. Defaults to 3000.'),
      },
    },
    (args) => {
      const sessionId = args.sessionId ?? store.listSessions()[0]?.sessionId;
      const events = store.query({
        limit: 200,
        ...(sessionId !== undefined && { sessionId }),
        ...(args.sinceMs !== undefined && { sinceMs: args.sinceMs }),
      });
      return jsonResult({
        sessionId: sessionId ?? null,
        ...buildTimeline(events, {
          ...(args.windowMs !== undefined && { windowMs: args.windowMs }),
        }),
      });
    },
  );

  server.registerTool(
    'get_performance',
    {
      title: 'Get performance metrics',
      description:
        'Current Web Vitals (FCP, LCP, CLS, INP, TTFB — each with its web.dev rating) ' +
        'and long-task pressure (count, total and worst duration) for a page session. ' +
        'Use this to answer "why is the page slow?" and to check the impact of a ' +
        'performance fix.',
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe('Scope to a page session; defaults to the most recently active one'),
        sinceMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only consider metrics newer than this epoch-milliseconds timestamp'),
      },
    },
    (args) => {
      const sessionId = args.sessionId ?? store.listSessions()[0]?.sessionId;
      const events = store.query({
        type: 'performance',
        limit: 200,
        ...(sessionId !== undefined && { sessionId }),
        ...(args.sinceMs !== undefined && { sinceMs: args.sinceMs }),
      });
      return jsonResult({
        sessionId: sessionId ?? null,
        ...summarizePerformance(events),
      });
    },
  );

  server.registerTool(
    'get_error_context',
    {
      title: 'Get error root-cause context',
      description:
        'One-call root-cause bundle for an error: the folded error record with ' +
        'source-mapped frames, the user interactions preceding its latest occurrence ' +
        '(each with the source location of the element), network requests and console ' +
        'warnings/errors in the same time window, and the session\u2019s Web Vitals. ' +
        'Reference the error by fingerprint or event id (both from get_recent_events); ' +
        'without a reference it explains the most recent error. Prefer this over ' +
        'correlating get_recent_events / get_interaction_timeline calls by hand.',
      inputSchema: {
        fingerprint: z
          .string()
          .min(1)
          .optional()
          .describe('Fingerprint of the folded error record'),
        errorId: z.string().min(1).optional().describe('Event id of the error'),
        lookbackMs: z
          .number()
          .int()
          .min(1000)
          .max(120_000)
          .optional()
          .describe('Cause-search window before the error. Defaults to 15000.'),
      },
    },
    (args) =>
      jsonResult(
        buildErrorContext(
          store,
          {
            ...(args.fingerprint !== undefined && { fingerprint: args.fingerprint }),
            ...(args.errorId !== undefined && { errorId: args.errorId }),
          },
          { ...(args.lookbackMs !== undefined && { lookbackMs: args.lookbackMs }) },
        ),
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

  server.registerTool(
    'wait_for_idle',
    {
      title: 'Wait for the page to go idle',
      description:
        'Blocks until the session\u2019s event stream has been quiet for quietMs (or ' +
        'timeoutMs elapses). Use it after perform_action or a code change to let the ' +
        'app finish reacting before asserting state with other tools.',
      inputSchema: {
        sessionId: z
          .string()
          .optional()
          .describe('Scope to a page session; defaults to the most recently active one'),
        quietMs: z
          .number()
          .int()
          .min(100)
          .max(10_000)
          .optional()
          .describe('Quiet window that counts as idle. Defaults to 1000.'),
        timeoutMs: z
          .number()
          .int()
          .min(500)
          .max(60_000)
          .optional()
          .describe('Max wait. Defaults to 10000.'),
      },
    },
    async (args) =>
      jsonResult(
        await waitForIdle(store, {
          ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
          ...(args.quietMs !== undefined && { quietMs: args.quietMs }),
          ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
        }),
      ),
  );

  if (ingest) {
    server.registerTool(
      'perform_action',
      {
        title: 'Perform a page action',
        description:
          'Drives the running page in the user\u2019s real browser session: click, type ' +
          'into an input, pick a select option, scroll, or navigate within the same ' +
          'origin. Locate elements by data-agentlens-source ("file:line", most stable), ' +
          'CSS selector, or visible text. The runtime dispatches synthetic events ' +
          '(React/Vue compatible), waits for the page to settle, and reports the ' +
          'errors, failed requests and console errors the action triggered — combine ' +
          'with get_recent_events or verify_fix to close the test loop. Requires the ' +
          'app to opt in via allowActions: true; refused while the user is actively ' +
          'interacting (retry shortly). Every synthetic interaction is captured with a ' +
          'synthetic: true marker as an audit trail.',
        inputSchema: {
          action: z.enum(['click', 'input', 'select', 'scroll', 'navigate']).describe('What to do'),
          source: z
            .string()
            .min(1)
            .optional()
            .describe('Locate by data-agentlens-source value, e.g. "src/App.vue:42"'),
          selector: z.string().min(1).optional().describe('Locate by CSS selector'),
          text: z.string().min(1).optional().describe('Locate by visible text (deepest match)'),
          nth: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Zero-based index when the locator matches multiple elements'),
          value: z
            .string()
            .optional()
            .describe('Text to type (input, empty string clears) or option value/label (select)'),
          url: z.string().min(1).optional().describe('Same-origin URL or path (navigate)'),
          x: z.number().optional().describe('Scroll x coordinate (scroll without target)'),
          y: z.number().optional().describe('Scroll y coordinate (scroll without target)'),
          sessionId: z
            .string()
            .optional()
            .describe('Target a specific page session; defaults to the most active one'),
        },
      },
      async (args) => {
        const target =
          args.source !== undefined || args.selector !== undefined || args.text !== undefined
            ? {
                ...(args.source !== undefined && { source: args.source }),
                ...(args.selector !== undefined && { selector: args.selector }),
                ...(args.text !== undefined && { text: args.text }),
                ...(args.nth !== undefined && { nth: args.nth }),
              }
            : undefined;
        const command: ActionCommand = {
          action: args.action,
          ...(target !== undefined && { target }),
          ...(args.value !== undefined && { value: args.value }),
          ...(args.url !== undefined && { url: args.url }),
          ...(args.x !== undefined && { x: args.x }),
          ...(args.y !== undefined && { y: args.y }),
        };
        try {
          const {
            kind: _kind,
            requestId: _requestId,
            ...result
          } = await ingest.requestAction(command, args.sessionId);
          return jsonResult(result);
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    );

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
