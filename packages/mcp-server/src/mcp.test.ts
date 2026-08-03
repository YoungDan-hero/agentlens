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
  ingest?: Pick<WsIngestServer, 'requestSnapshot'>,
): Promise<Client> {
  const server = createMcpServer(store, '0.0.0-test', ingest);
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
  it('registers all eight tools when an ingest server is provided', async () => {
    const client = await connect(new EventStore(), {
      requestSnapshot: () => Promise.reject(new Error('unused')),
    });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_error_context',
      'get_interaction_timeline',
      'get_layout_snapshot',
      'get_page_health',
      'get_performance',
      'get_recent_events',
      'list_sessions',
      'verify_fix',
    ]);
  });

  it('omits get_layout_snapshot without an ingest server', async () => {
    const client = await connect(new EventStore());
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain('get_layout_snapshot');
    expect(tools).toHaveLength(7);
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
    });

    const result = await callJson(client, 'get_layout_snapshot');

    expect(result.error).toBe('No browser session is connected.');
  });
});
