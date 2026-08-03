import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { EventStore } from './store';
import { buildErrorContext } from './error-context';
import { buildReplayScript } from './replay';
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
  ingest?: Pick<
    WsIngestServer,
    | 'requestSnapshot'
    | 'requestAction'
    | 'requestActionSequence'
    | 'requestSourceQuery'
    | 'sessionFocus'
  >,
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
        'first. Connected sessions carry live focus state: `focused: true` marks ' +
        'the page the user is looking at right now — prefer it when the user says ' +
        '"this page" — and `liveUrl` reflects the current SPA route even when no ' +
        'events fired since. Use the sessionId to scope other tools.',
    },
    () => {
      const focus = new Map((ingest?.sessionFocus() ?? []).map((s) => [s.sessionId, s]));
      return jsonResult(
        store.listSessions().map((session) => {
          const live = focus.get(session.sessionId);
          return {
            ...session,
            connected: live !== undefined,
            visible: live?.visible ?? null,
            focused: live?.focused ?? null,
            // Fresher than `url` after SPA route changes that emit no events.
            liveUrl: live?.url ?? null,
          };
        }),
      );
    },
  );

  server.registerTool(
    'get_recent_events',
    {
      title: 'Get recent events',
      description:
        'Query captured runtime events (errors, console output, network requests, ' +
        'lifecycle, performance), newest first. Filter by type, time or source file ' +
        'to keep responses small.',
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
        source: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only events attributed to this source file (`src/App.vue`) or line ' +
              '(`src/App.vue:42`): interactions on its elements, errors whose ' +
              'resolved stack passes through it, requests it initiated',
          ),
      },
    },
    (args) =>
      jsonResult(
        store.query({
          ...(args.type !== undefined && { type: args.type }),
          ...(args.sessionId !== undefined && { sessionId: args.sessionId }),
          ...(args.sinceMs !== undefined && { sinceMs: args.sinceMs }),
          ...(args.limit !== undefined && { limit: args.limit }),
          ...(args.source !== undefined && { source: args.source }),
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
        // Unbounded: one-shot vitals (FCP, TTFB) must survive long-task
        // storms that would push them out of a small newest-first sample.
        limit: Infinity,
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
          .describe(
            'Scope to a page session; defaults to the focused session when known, ' +
              'else the most recently active one',
          ),
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
    async (args) => {
      // The page the user is looking at is the one the agent is testing;
      // fall back to waitForIdle's own default (most recently active).
      const focused = ingest?.sessionFocus().find((session) => session.focused === true)?.sessionId;
      const sessionId = args.sessionId ?? focused;
      return jsonResult(
        await waitForIdle(store, {
          ...(sessionId !== undefined && { sessionId }),
          ...(args.quietMs !== undefined && { quietMs: args.quietMs }),
          ...(args.timeoutMs !== undefined && { timeoutMs: args.timeoutMs }),
        }),
      );
    },
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

    const waitForSchema = z
      .object({
        source: z.string().min(1).optional().describe('Await element(s) with this source value'),
        selector: z.string().min(1).optional().describe('Await element(s) matching this selector'),
        text: z.string().min(1).optional().describe('Await element(s) containing this text'),
        state: z
          .enum(['visible', 'attached', 'hidden'])
          .optional()
          .describe('Condition to await; defaults to visible'),
        timeoutMs: z.number().int().min(50).max(15_000).optional().describe('Defaults to 5000'),
      })
      .describe('Condition to await before executing this step');

    const stepSchema = z.object({
      action: z.enum(['click', 'input', 'select', 'scroll', 'navigate']),
      source: z.string().min(1).optional().describe('Locate by data-agentlens-source value'),
      selector: z.string().min(1).optional().describe('Locate by CSS selector'),
      text: z.string().min(1).optional().describe('Locate by visible text'),
      nth: z.number().int().min(0).optional().describe('Index when the locator is ambiguous'),
      value: z.string().optional().describe('Text to type or option to pick'),
      url: z.string().min(1).optional().describe('Same-origin URL (navigate, last step only)'),
      x: z.number().optional().describe('Scroll x (scroll without target)'),
      y: z.number().optional().describe('Scroll y (scroll without target)'),
      waitFor: waitForSchema.optional(),
    });

    server.registerTool(
      'perform_actions',
      {
        title: 'Perform a sequence of page actions',
        description:
          'Runs up to 20 page actions in order in one round-trip — the fast path for ' +
          'scripted flows like filling a form and submitting it. Each step may declare ' +
          'a waitFor condition (element visible/attached/hidden) that is polled locally ' +
          'before the step executes, so async UI (loading options, conditional fields) ' +
          'needs no agent round-trip. The sequence stops at the first failure — or ' +
          'immediately if the user starts interacting — and reports the break point ' +
          '(stoppedAt, stopReason), per-step outcomes, accumulated effects and the ' +
          'final URL, so you can re-plan from where it stopped. navigate is only ' +
          'allowed as the final step. Same opt-in and audit trail as perform_action.',
        inputSchema: {
          steps: z.array(stepSchema).min(1).max(20).describe('Steps to run in order'),
          sessionId: z
            .string()
            .optional()
            .describe('Target a specific page session; defaults to the focused one'),
        },
      },
      async (args) => {
        const steps = args.steps.map((step) => {
          const target =
            step.source !== undefined || step.selector !== undefined || step.text !== undefined
              ? {
                  ...(step.source !== undefined && { source: step.source }),
                  ...(step.selector !== undefined && { selector: step.selector }),
                  ...(step.text !== undefined && { text: step.text }),
                  ...(step.nth !== undefined && { nth: step.nth }),
                }
              : undefined;
          return {
            action: step.action,
            ...(target !== undefined && { target }),
            ...(step.value !== undefined && { value: step.value }),
            ...(step.url !== undefined && { url: step.url }),
            ...(step.x !== undefined && { x: step.x }),
            ...(step.y !== undefined && { y: step.y }),
            ...(step.waitFor !== undefined && {
              waitFor: {
                ...(step.waitFor.source !== undefined && { source: step.waitFor.source }),
                ...(step.waitFor.selector !== undefined && { selector: step.waitFor.selector }),
                ...(step.waitFor.text !== undefined && { text: step.waitFor.text }),
                ...(step.waitFor.state !== undefined && { state: step.waitFor.state }),
                ...(step.waitFor.timeoutMs !== undefined && { timeoutMs: step.waitFor.timeoutMs }),
              },
            }),
          };
        });
        // Budget: per step, the wait ceiling plus the settle ceiling (5s),
        // plus a fixed margin — capped so a runaway page cannot hold the
        // agent hostage for minutes.
        const timeoutMs = Math.min(
          steps.reduce(
            (sum, step) => sum + Math.min(step.waitFor?.timeoutMs ?? 5000, 15_000) + 5000,
            5000,
          ),
          90_000,
        );
        try {
          const {
            kind: _kind,
            requestId: _requestId,
            ...result
          } = await ingest.requestActionSequence(steps, args.sessionId, timeoutMs);
          return jsonResult(result);
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    );

    server.registerTool(
      'replay_error_path',
      {
        title: 'Replay the interaction path that led to an error',
        description:
          'Turns the human interactions that preceded an error into an action ' +
          'sequence and (optionally) runs it — the one-command fix-verification ' +
          'loop: fix the code, replay the path, see whether the error recurs. ' +
          'Defaults to a dry run that returns the derived script: review it, ' +
          'supply values for input steps (typed values are never captured), then ' +
          'call again with dryRun: false. Execution reports the sequence outcome ' +
          'plus errorRecurred, comparing the error fingerprint\u2019s occurrence ' +
          'count before and after the run. If the page has navigated away since, ' +
          'navigate back to errorUrl first. Requires allowActions: true.',
        inputSchema: {
          fingerprint: z
            .string()
            .min(1)
            .optional()
            .describe('Error fingerprint (from get_page_health / get_recent_events)'),
          errorId: z
            .string()
            .min(1)
            .optional()
            .describe('Error event id; defaults to the most recent error'),
          lookbackMs: z
            .number()
            .int()
            .min(1000)
            .max(120_000)
            .optional()
            .describe('How far before the error to look for interactions; defaults to 15000'),
          dryRun: z
            .boolean()
            .optional()
            .describe('Default true: return the derived script without executing it'),
          values: z
            .record(z.string(), z.string())
            .optional()
            .describe('Text for input steps, keyed by step index, e.g. {"0": "Ada"}'),
          sessionId: z
            .string()
            .optional()
            .describe('Session to replay in; defaults to the focused one'),
        },
      },
      async (args) => {
        const script = buildReplayScript(
          store,
          {
            ...(args.fingerprint !== undefined && { fingerprint: args.fingerprint }),
            ...(args.errorId !== undefined && { errorId: args.errorId }),
          },
          { ...(args.lookbackMs !== undefined && { lookbackMs: args.lookbackMs }) },
        );
        if (!('steps' in script)) {
          return jsonResult(script);
        }

        const steps = script.steps.map((step, index) => {
          const value = args.values?.[String(index)];
          return step.action === 'input' && value !== undefined ? { ...step, value } : step;
        });
        const missingValues = script.needsValue.filter(
          (index) => args.values?.[String(index)] === undefined,
        );

        if (args.dryRun !== false) {
          return jsonResult({
            ...script,
            hint:
              missingValues.length > 0
                ? `supply values for input step(s) ${missingValues.join(', ')} and call again with dryRun: false`
                : 'call again with dryRun: false to execute',
          });
        }
        if (!script.executable) {
          return jsonResult({
            error: 'the script cannot run as-is — see warnings',
            warnings: script.warnings,
          });
        }
        if (missingValues.length > 0) {
          return jsonResult({
            error:
              `input step(s) ${missingValues.join(', ')} need a value — pass ` +
              'values: {"<stepIndex>": "text"} (typed values are never captured)',
          });
        }

        const occurrencesBefore =
          script.fingerprint !== null
            ? (store.getErrorByFingerprint(script.fingerprint)?.occurrences ?? 0)
            : 0;
        const timeoutMs = Math.min(steps.length * 10_000 + 5000, 90_000);
        try {
          const {
            kind: _kind,
            requestId: _requestId,
            ...result
          } = await ingest.requestActionSequence(steps, args.sessionId, timeoutMs);
          // Quiet-path ordering (batch every ~100ms, result after ≥500ms of
          // quiet) makes the error batch arrive first — but a sequence whose
          // settle TIMED OUT returns while events are still flowing, and the
          // result frame (sendRaw, unbatched) can overtake the final batch.
          // A grace period longer than the batch window closes that race.
          await new Promise((resolve) => setTimeout(resolve, 250));
          const occurrencesAfter =
            script.fingerprint !== null
              ? (store.getErrorByFingerprint(script.fingerprint)?.occurrences ?? 0)
              : 0;
          return jsonResult({
            ...result,
            fingerprint: script.fingerprint,
            occurrencesBefore,
            occurrencesAfter,
            errorRecurred: occurrencesAfter > occurrencesBefore,
          });
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

    server.registerTool(
      'find_elements_by_source',
      {
        title: 'Find elements rendered by a source file',
        description:
          'Reverse source lookup: lists the elements a source file is rendering on ' +
          'the live page right now (tag, id, visible text, visibility, exact ' +
          '"file:line" attribution). Use it right after editing a component to see ' +
          'its runtime output, or to find something to click for perform_action. ' +
          'Complements get_recent_events\u2019 source filter, which answers what ' +
          'happened around this file\u2019s elements.',
        inputSchema: {
          file: z
            .string()
            .min(1)
            .describe('Source path as attributed, e.g. "src/App.vue", or exact "src/App.vue:42"'),
          sessionId: z
            .string()
            .optional()
            .describe('Target a specific page session; defaults to the most active one'),
        },
      },
      async (args) => {
        try {
          return jsonResult(await ingest.requestSourceQuery(args.file, args.sessionId));
        } catch (error) {
          return jsonResult({ error: error instanceof Error ? error.message : String(error) });
        }
      },
    );
  }

  return server;
}
