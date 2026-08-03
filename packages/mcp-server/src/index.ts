#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_WS_PORT } from '@agentlensjs/shared';

import { createMcpServer } from './mcp';
import { parseAllowedOrigins } from './origin';
import { StackResolver } from './stack-resolver';
import { EventStore } from './store';
import { startWsIngestServer } from './ws-server';

// dist/index.js sits one level below the package root.
const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function main(): Promise<void> {
  const port = resolvePort();
  const store = new EventStore();
  const ingest = startWsIngestServer(store, port, new StackResolver(), {
    allowedOrigins: parseAllowedOrigins(process.env.AGENTLENS_ALLOWED_ORIGINS),
  });

  const server = createMcpServer(store, VERSION, ingest);
  await server.connect(new StdioServerTransport());

  // stdout is reserved for the MCP protocol; diagnostics go to stderr.
  console.error(`[agentlens] daemon ready (v${VERSION})`);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    // Hard-exit fallback: a wedged browser tab can stall the graceful
    // close handshake for ~30s (ws internal timeout), keeping the port
    // occupied exactly when an MCP reload wants to start the next daemon.
    setTimeout(() => process.exit(0), 3000).unref();
    void ingest.close().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // MCP clients (Cursor, Claude Code) stop or reload the server by closing
  // its stdio pipes, not by signalling. Without these handlers the daemon
  // would outlive every reload as an orphan and keep the ingest port
  // occupied, breaking the next daemon with EADDRINUSE.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

function resolvePort(): number {
  const raw = process.env.AGENTLENS_PORT;
  if (raw === undefined) {
    return DEFAULT_WS_PORT;
  }
  // Number() instead of parseInt(): "8080abc" must fail, not become 8080.
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new RangeError(`Invalid AGENTLENS_PORT: ${raw}`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  console.error('[agentlens] fatal:', error);
  process.exit(1);
});
