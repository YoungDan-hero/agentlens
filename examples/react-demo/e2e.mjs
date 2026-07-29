// End-to-end verification of the full AgentLens chain:
//   browser signals -> runtime SDK -> WebSocket -> daemon -> MCP tools.
// Usage: pnpm --filter react-demo e2e
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const DEMO_URL = 'http://localhost:5273/';
const DAEMON_ENTRY = new URL('../../packages/mcp-server/dist/index.js', import.meta.url).pathname;
const DEMO_DIR = new URL('.', import.meta.url).pathname;

/** Minimal MCP client speaking newline-delimited JSON-RPC over stdio. */
class McpClient {
  #proc;
  #pending = new Map();
  #nextId = 1;
  #buffer = '';

  constructor(proc) {
    this.#proc = proc;
    proc.stdout.on('data', (chunk) => {
      this.#buffer += chunk.toString();
      let index;
      while ((index = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const resolve = this.#pending.get(message.id);
        if (resolve) {
          this.#pending.delete(message.id);
          resolve(message);
        }
      }
    });
  }

  notify(method, params) {
    this.#proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(method, params) {
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 10_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(`MCP error for ${method}: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result);
        }
      });
      this.#proc.stdin.write(payload + '\n');
    });
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    return JSON.parse(result.content[0].text);
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server not up yet; keep polling.
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const failures = [];
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  console.log(`  [${status}] ${label}`);
  if (!condition) failures.push(label);
}

async function main() {
  console.log('1/5 Starting AgentLens daemon...');
  const daemon = spawn('node', [DAEMON_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  daemon.stderr.on('data', (d) => process.stdout.write(`      [daemon] ${d}`));

  console.log('2/5 Starting Vite dev server...');
  // Spawn the vite entry directly (not via `pnpm exec`) so kill() reaches
  // the actual server process instead of a wrapper.
  const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--strictPort', '--port', '5273'], {
    cwd: DEMO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForHttp(DEMO_URL, 30_000);

  console.log('3/5 Launching headless Chrome and triggering signals...');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(DEMO_URL, { waitUntil: 'networkidle' });
    // Cold-start dependency optimization makes Vite reload the page once or
    // twice; a warm reload gives the clicks a stable session to land on.
    await sleep(1_500);
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(500);

    for (const id of ['btn-error', 'btn-rejection', 'btn-console', 'btn-404', 'btn-network-fail']) {
      await page.click(`#${id}`);
      await sleep(200);
    }

    console.log('4/5 Querying the daemon over MCP...');
    const client = new McpClient(daemon);
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    });
    client.notify('notifications/initialized');

    // The unreachable-host fetch only settles after DNS resolution fails,
    // so poll until both failed requests have landed instead of guessing.
    let health = await client.callTool('get_page_health');
    const pollDeadline = Date.now() + 15_000;
    while (health.failedRequestCount < 2 && Date.now() < pollDeadline) {
      await sleep(500);
      health = await client.callTool('get_page_health');
    }
    console.log(`      health = ${JSON.stringify(health)}`);

    const errors = await client.callTool('get_recent_events', { type: 'error' });
    const consoles = await client.callTool('get_recent_events', { type: 'console' });
    const network = await client.callTool('get_recent_events', { type: 'network' });
    const lifecycle = await client.callTool('get_recent_events', { type: 'lifecycle' });

    console.log('5/5 Asserting the captured signals...');
    assert(
      lifecycle.some((e) => e.phase === 'load'),
      'lifecycle: page load event captured',
    );
    assert(
      errors.some((e) => e.subtype === 'uncaught' && e.message.includes('uncaught error')),
      'error: uncaught exception captured',
    );
    assert(
      errors.some((e) => e.subtype === 'unhandledrejection'),
      'error: unhandled rejection captured',
    );
    assert(
      consoles.some((e) => e.level === 'error' && e.args[0]?.includes('console.error')),
      'console: console.error captured with args',
    );
    assert(
      network.some((e) => e.requestUrl.includes('/api/does-not-exist') && e.status === 404),
      'network: 404 response captured',
    );
    assert(
      network.some((e) => e.requestUrl.includes('unreachable.invalid') && e.status === null),
      'network: transport failure captured with null status',
    );
    assert(health.errorCount >= 2, `health: errorCount >= 2 (got ${health.errorCount})`);
    assert(
      health.failedRequestCount >= 2,
      `health: failedRequestCount >= 2 (got ${health.failedRequestCount})`,
    );
  } finally {
    await browser.close();
    vite.kill('SIGTERM');
    daemon.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\nE2E FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nE2E PASSED: full chain verified (browser -> runtime -> daemon -> MCP)');
  // Child stdio pipes can keep the event loop alive; exit explicitly.
  process.exit(0);
}

// Watchdog: never leave the pipeline hanging on an unexpected stall.
const watchdog = setTimeout(() => {
  console.error('E2E watchdog: timed out after 90s');
  process.exit(1);
}, 90_000);
watchdog.unref();

main().catch((error) => {
  console.error('E2E crashed:', error);
  process.exit(1);
});
