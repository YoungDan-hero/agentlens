import type { ErrorEvent, InteractionEvent, PerformanceEvent } from '@agentlensjs/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { createMcpServer } from './mcp';
import { EventStore } from './store';
import type { WsIngestServer } from './ws-server';

let counter = 0;

function makeError(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'error',
    subtype: 'uncaught',
    timestamp: Date.now(),
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    message: 'boom',
    stack: null,
    frames: [],
    occurrences: 1,
    ...overrides,
  };
}

function makeInteraction(): InteractionEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'interaction',
    subtype: 'click',
    timestamp: Date.now(),
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    target: { tag: 'button', id: 'save', text: 'Save', source: 'src/App.tsx:10' },
  };
}

function makePerformance(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
  counter += 1;
  return {
    id: `event-${String(counter)}`,
    type: 'performance',
    timestamp: Date.now(),
    sessionId: 'session-1',
    url: 'http://localhost:5173/',
    metric: 'LCP',
    value: 1200,
    rating: 'good',
    detail: null,
    ...overrides,
  };
}

/** Wires a real MCP client to the server over an in-memory transport. */
async function connect(
  store: EventStore,
  ingest?: Partial<
    Pick<
      WsIngestServer,
      | 'requestSnapshot'
      | 'requestAction'
      | 'requestActionSequence'
      | 'requestSourceQuery'
      | 'sessionFocus'
    >
  >,
): Promise<Client> {
  const server = createMcpServer(
    store,
    '0.0.0-test',
    ingest && {
      requestSnapshot: ingest.requestSnapshot ?? (() => Promise.reject(new Error('unused'))),
      requestAction: ingest.requestAction ?? (() => Promise.reject(new Error('unused'))),
      requestActionSequence:
        ingest.requestActionSequence ?? (() => Promise.reject(new Error('unused'))),
      requestSourceQuery: ingest.requestSourceQuery ?? (() => Promise.reject(new Error('unused'))),
      sessionFocus: ingest.sessionFocus ?? (() => []),
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Extracts and parses the JSON payload every AgentLens tool returns. */
async function callJson(client: Client, name: string, args?: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args ?? {} });
  const [first] = result.content as { type: string; text: string }[];
  if (first?.type !== 'text') {
    throw new Error(`expected a text result from ${name}`);
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('createMcpServer', () => {
  it('registers all thirteen tools when an ingest server is provided', async () => {
    const client = await connect(new EventStore(), {
      requestSnapshot: () => Promise.reject(new Error('unused')),
      requestAction: () => Promise.reject(new Error('unused')),
    });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'find_elements_by_source',
      'get_error_context',
      'get_interaction_timeline',
      'get_layout_snapshot',
      'get_page_health',
      'get_performance',
      'get_recent_events',
      'list_sessions',
      'perform_action',
      'perform_actions',
      'replay_error_path',
      'verify_fix',
      'wait_for_idle',
    ]);
  });

  it('omits the browser-channel tools without an ingest server', async () => {
    const client = await connect(new EventStore());
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain('get_layout_snapshot');
    expect(tools.map((tool) => tool.name)).not.toContain('perform_action');
    expect(tools.map((tool) => tool.name)).not.toContain('find_elements_by_source');
    expect(tools).toHaveLength(8);
  });

  it('get_recent_events filters by source attribution', async () => {
    const store = new EventStore();
    store.add(makeInteraction()); // target.source = src/App.tsx:10
    store.add(makeError()); // no frames -> never matches a source filter
    const client = await connect(store);

    const byFile = (await callJson(client, 'get_recent_events', {
      source: 'src/App.tsx',
    })) as unknown as { type: string }[];
    expect(byFile).toHaveLength(1);
    expect(byFile[0]?.type).toBe('interaction');

    const byLine = (await callJson(client, 'get_recent_events', {
      source: 'src/App.tsx:10',
    })) as unknown as unknown[];
    expect(byLine).toHaveLength(1);

    const miss = (await callJson(client, 'get_recent_events', {
      source: 'src/Other.tsx',
    })) as unknown as unknown[];
    expect(miss).toHaveLength(0);
  });

  it('find_elements_by_source forwards the query and surfaces failures', async () => {
    let received: unknown;
    const client = await connect(new EventStore(), {
      requestSourceQuery: (source, sessionId) => {
        received = { source, sessionId };
        return Promise.resolve({
          kind: 'source-query-response' as const,
          requestId: 'r1',
          sessionId: 'session-1',
          url: 'http://localhost:5173/',
          capturedAt: Date.now(),
          elements: [
            { tag: 'button', id: 'go', text: 'Go', visible: true, source: 'src/App.vue:3' },
          ],
          truncated: false,
        });
      },
    });

    const result = await callJson(client, 'find_elements_by_source', { file: 'src/App.vue' });
    expect(received).toEqual({ source: 'src/App.vue', sessionId: undefined });
    expect(result.elements).toHaveLength(1);

    const failing = await connect(new EventStore(), {
      requestSourceQuery: () => Promise.reject(new Error('No browser session is connected.')),
    });
    const failure = await callJson(failing, 'find_elements_by_source', { file: 'src/App.vue' });
    expect(failure.error).toBe('No browser session is connected.');
  });

  it('list_sessions merges live focus state from connected sessions', async () => {
    const store = new EventStore();
    store.add(makeError({ sessionId: 'session-1' }));
    store.add(makeError({ sessionId: 'session-2' }));
    const client = await connect(store, {
      sessionFocus: () => [
        {
          sessionId: 'session-1',
          visible: true,
          focused: true,
          url: 'http://localhost:5173/#/settings',
        },
      ],
    });

    const sessions = (await callJson(client, 'list_sessions')) as unknown as {
      sessionId: string;
      connected: boolean;
      visible: boolean | null;
      focused: boolean | null;
      liveUrl: string | null;
    }[];

    const focusedSession = sessions.find((s) => s.sessionId === 'session-1');
    const staleSession = sessions.find((s) => s.sessionId === 'session-2');
    expect(focusedSession).toMatchObject({
      connected: true,
      visible: true,
      focused: true,
      liveUrl: 'http://localhost:5173/#/settings',
    });
    // Disconnected sessions carry no live state — null, not false.
    expect(staleSession).toMatchObject({
      connected: false,
      visible: null,
      focused: null,
      liveUrl: null,
    });
  });

  it('get_page_health summarizes the store', async () => {
    const store = new EventStore();
    store.add(makeError());
    const client = await connect(store);

    const health = await callJson(client, 'get_page_health');

    expect(health.sessionId).toBe('session-1');
    expect(health.errorCount).toBe(1);
    expect(health.errorOccurrences).toBe(1);
  });

  it('get_recent_events applies filters and rejects invalid arguments', async () => {
    const store = new EventStore();
    store.add(makeError({ message: 'first' }));
    store.add(makeError({ message: 'second', stack: 'Error\n    at other (B.tsx:1:1)' }));
    const client = await connect(store);

    const events = (await callJson(client, 'get_recent_events', {
      type: 'error',
      limit: 1,
    })) as unknown as unknown[];
    expect(events).toHaveLength(1);

    const invalid = await client.callTool({
      name: 'get_recent_events',
      arguments: { type: 'not-a-type' },
    });
    expect(invalid.isError).toBe(true);
  });

  it('get_interaction_timeline groups effects under interactions', async () => {
    const store = new EventStore();
    const interaction = makeInteraction();
    store.add(interaction);
    store.add(makeError({ timestamp: interaction.timestamp + 100 }));
    const client = await connect(store);

    const timeline = await callJson(client, 'get_interaction_timeline');

    const groups = timeline.groups as { effects: unknown[] }[];
    expect(groups).toHaveLength(1);
    expect(groups[0]?.effects).toHaveLength(1);
    expect(timeline.sessionId).toBe('session-1');
  });

  it('get_performance reduces metrics for the active session', async () => {
    const store = new EventStore();
    store.add(makePerformance({ metric: 'LCP', value: 1200, rating: 'good', timestamp: 1000 }));
    store.add(
      makePerformance({ metric: 'LCP', value: 2900, rating: 'needs-improvement', timestamp: 2000 }),
    );
    store.add(makePerformance({ metric: 'long-task', value: 180, rating: null, detail: 'script' }));
    const client = await connect(store);

    const result = await callJson(client, 'get_performance');

    expect(result.sessionId).toBe('session-1');
    const webVitals = result.webVitals as Record<string, { value: number } | null>;
    expect(webVitals.LCP?.value).toBe(2900);
    expect(webVitals.CLS).toBeNull();
    const longTasks = result.longTasks as { count: number; maxMs: number };
    expect(longTasks.count).toBe(1);
    expect(longTasks.maxMs).toBe(180);
  });

  it('get_error_context bundles the error with its preceding interaction', async () => {
    const store = new EventStore();
    const interaction = makeInteraction();
    store.add(interaction);
    store.add(makeError({ timestamp: interaction.timestamp + 100 }));
    const client = await connect(store);

    const context = await callJson(client, 'get_error_context');

    expect((context.error as { message: string }).message).toBe('boom');
    const interactions = context.precedingInteractions as { target: { source: string } }[];
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.target.source).toBe('src/App.tsx:10');
    expect(context.performance).toBeDefined();
  });

  it('verify_fix reports an unknown fingerprint as an actionable error', async () => {
    const client = await connect(new EventStore());

    const result = await callJson(client, 'verify_fix', { fingerprint: 'nope' });

    expect(result.error).toContain('No captured error matches fingerprint');
  });

  it('get_layout_snapshot surfaces ingest failures as an error payload', async () => {
    const client = await connect(new EventStore(), {
      requestSnapshot: () => Promise.reject(new Error('No browser session is connected.')),
      requestAction: () => Promise.reject(new Error('unused')),
    });

    const result = await callJson(client, 'get_layout_snapshot');

    expect(result.error).toBe('No browser session is connected.');
  });

  it('perform_action forwards the command and strips the wire envelope', async () => {
    let received: unknown;
    const client = await connect(new EventStore(), {
      requestSnapshot: () => Promise.reject(new Error('unused')),
      requestAction: (command, sessionId) => {
        received = { command, sessionId };
        return Promise.resolve({
          kind: 'action-result' as const,
          requestId: 'r1',
          sessionId: 'session-1',
          ok: true,
          error: null,
          target: { tag: 'button', id: 'go', text: 'Go', source: 'src/App.vue:3' },
          effects: { errors: 0, failedRequests: 0, consoleErrors: 0 },
          settledAfterMs: 90,
          settleTimedOut: false,
        });
      },
    });

    const result = await callJson(client, 'perform_action', {
      action: 'input',
      selector: '#name',
      value: 'Ada',
    });

    expect(received).toEqual({
      command: { action: 'input', target: { selector: '#name' }, value: 'Ada' },
      sessionId: undefined,
    });
    expect(result.ok).toBe(true);
    // Wire-envelope fields are daemon-internal and must not reach the agent.
    expect(result.kind).toBeUndefined();
    expect(result.requestId).toBeUndefined();
  });

  it('perform_actions maps steps onto the wire shape and strips the envelope', async () => {
    let received: unknown;
    const client = await connect(new EventStore(), {
      requestActionSequence: (steps, sessionId, timeoutMs) => {
        received = { steps, sessionId, timeoutMs };
        return Promise.resolve({
          kind: 'action-sequence-result' as const,
          requestId: 'r1',
          sessionId: 'session-1',
          ok: true,
          stoppedAt: null,
          stopReason: null,
          stepResults: [],
          totalEffects: { errors: 0, failedRequests: 0, consoleErrors: 0 },
          finalUrl: 'http://localhost:5173/',
        });
      },
    });

    const result = await callJson(client, 'perform_actions', {
      steps: [
        { action: 'input', selector: '#name', value: 'Ada' },
        { action: 'click', text: 'Submit', waitFor: { selector: '#name', state: 'visible' } },
      ],
    });

    expect(received).toMatchObject({
      steps: [
        { action: 'input', target: { selector: '#name' }, value: 'Ada' },
        { action: 'click', target: { text: 'Submit' }, waitFor: { selector: '#name' } },
      ],
    });
    // Budget: 2 steps x (5000 wait + 5000 settle) + 5000 margin.
    expect((received as { timeoutMs: number }).timeoutMs).toBe(25_000);
    expect(result.ok).toBe(true);
    expect(result.kind).toBeUndefined();
    expect(result.requestId).toBeUndefined();
  });

  it('replay_error_path dry-runs a script, then executes with values and reports recurrence', async () => {
    const store = new EventStore();
    const interaction: InteractionEvent = {
      id: 'i-replay',
      type: 'interaction',
      subtype: 'input',
      timestamp: Date.now() - 500,
      sessionId: 'session-1',
      url: 'http://localhost:5173/',
      target: { tag: 'input', id: 'email', text: null, source: null },
    };
    store.add(interaction);
    const stored = store.add(
      makeError({ stack: 'Error: boom\n    at pay (http://localhost:5173/src/pay.ts:1:1)' }),
    );

    let executed: unknown;
    const client = await connect(store, {
      requestActionSequence: (steps) => {
        executed = steps;
        // The replayed path re-triggers the error: the store folds a repeat.
        store.add(
          makeError({
            stack: 'Error: boom\n    at pay (http://localhost:5173/src/pay.ts:1:1)',
          }),
        );
        return Promise.resolve({
          kind: 'action-sequence-result' as const,
          requestId: 'r1',
          sessionId: 'session-1',
          ok: true,
          stoppedAt: null,
          stopReason: null,
          stepResults: [],
          totalEffects: { errors: 1, failedRequests: 0, consoleErrors: 0 },
          finalUrl: 'http://localhost:5173/',
        });
      },
    });

    const dry = await callJson(client, 'replay_error_path', { errorId: stored.id });
    expect(dry.executable).toBe(true);
    expect(dry.needsValue).toEqual([0]);
    expect(String(dry.hint)).toContain('supply values');
    expect(executed).toBeUndefined();

    const run = await callJson(client, 'replay_error_path', {
      errorId: stored.id,
      dryRun: false,
      values: { '0': 'ada@example.com' },
    });
    expect(executed).toEqual([
      { action: 'input', target: { selector: '[id="email"]' }, value: 'ada@example.com' },
    ]);
    expect(run.errorRecurred).toBe(true);
    expect(run.occurrencesBefore).toBe(1);
    expect(run.occurrencesAfter).toBe(2);
  });

  it('replay_error_path refuses to execute with missing input values', async () => {
    const store = new EventStore();
    store.add({
      id: 'i-noval',
      type: 'interaction',
      subtype: 'input',
      timestamp: Date.now() - 500,
      sessionId: 'session-1',
      url: 'http://localhost:5173/',
      target: { tag: 'input', id: 'email', text: null, source: null },
    } satisfies InteractionEvent);
    const stored = store.add(makeError());
    const client = await connect(store, {});

    const result = await callJson(client, 'replay_error_path', {
      errorId: stored.id,
      dryRun: false,
    });
    expect(result.error).toContain('need a value');
  });

  it('perform_action surfaces transport failures as an error payload', async () => {
    const client = await connect(new EventStore(), {
      requestSnapshot: () => Promise.reject(new Error('unused')),
      requestAction: () => Promise.reject(new Error('No browser session is connected.')),
    });

    const result = await callJson(client, 'perform_action', { action: 'click', selector: '#x' });

    expect(result.error).toBe('No browser session is connected.');
  });

  it('wait_for_idle reports idle for a quiet store', async () => {
    const client = await connect(new EventStore());

    const result = await callJson(client, 'wait_for_idle', { quietMs: 100 });

    expect(result.idle).toBe(true);
    expect(result.lastEventAt).toBeNull();
  });
});
