#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_WS_PORT } from '@agentlens/shared';

import { createMcpServer } from './mcp';
import { StackResolver } from './stack-resolver';
import { EventStore } from './store';
import { startWsIngestServer } from './ws-server';

const VERSION = '0.0.0';

async function main(): Promise<void> {
  const port = resolvePort();
  const store = new EventStore();
  const ingest = startWsIngestServer(store, port, new StackResolver());

  const server = createMcpServer(store, VERSION);
  await server.connect(new StdioServerTransport());

  // stdout is reserved for the MCP protocol; diagnostics go to stderr.
  console.error(`[agentlens] daemon ready — ingesting on ws://localhost:${String(port)}`);

  const shutdown = (): void => {
    void ingest.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function resolvePort(): number {
  const raw = process.env.AGENTLENS_PORT;
  if (raw === undefined) {
    return DEFAULT_WS_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new RangeError(`Invalid AGENTLENS_PORT: ${raw}`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  console.error('[agentlens] fatal:', error);
  process.exit(1);
});
