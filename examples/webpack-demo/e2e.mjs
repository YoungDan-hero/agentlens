// Smoke test for the documented manual (non-Vite) integration path:
//   webpack app -> @agentlensjs/runtime (manual init) -> daemon -> MCP tools.
// Usage: pnpm --filter webpack-demo e2e
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Dedicated ports so this never collides with the react-demo E2E (8632/5274)
// or a developer's running daemon (8631).
const WEBPACK_PORT = '5275';
const DAEMON_PORT = '8633';
const DEMO_URL = `http://127.0.0.1:${WEBPACK_PORT}/`;
const DAEMON_ENTRY = fileURLToPath(
  new URL('../../packages/mcp-server/dist/index.js', import.meta.url),
);
const DEMO_DIR = fileURLToPath(new URL('.', import.meta.url));

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
  console.log('1/4 Starting AgentLens daemon...');
  const daemon = spawn('node', [DAEMON_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENTLENS_PORT: DAEMON_PORT },
  });
  daemon.stderr.on('data', (d) => process.stdout.write(`      [daemon] ${d}`));

  console.log('2/4 Starting webpack dev server...');
  const devServer = spawn('node', ['node_modules/webpack/bin/webpack.js', 'serve'], {
    cwd: DEMO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENTLENS_PORT: DAEMON_PORT, WEBPACK_PORT },
  });
  await waitForHttp(DEMO_URL, 60_000);

  console.log('3/4 Opening the page in headless Chrome...');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(DEMO_URL, { waitUntil: 'networkidle' });

    const client = new McpClient(daemon);
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'webpack-smoke', version: '0.0.0' },
    });
    client.notify('notifications/initialized');

    // Events flow through the runtime's micro-batching transport; poll
    // until every expected signal kind has landed instead of guessing.
    let errors = [];
    let consoles = [];
    let network = [];
    const deadline = Date.now() + 20_000;
    while (
      (errors.length === 0 || consoles.length === 0 || network.length === 0) &&
      Date.now() < deadline
    ) {
      await sleep(500);
      [errors, consoles, network] = await Promise.all([
        client.callTool('get_recent_events', { type: 'error' }),
        client.callTool('get_recent_events', { type: 'console' }),
        client.callTool('get_recent_events', { type: 'network' }),
      ]);
    }
    const lifecycle = await client.callTool('get_recent_events', { type: 'lifecycle' });

    console.log('4/4 Asserting the captured signals...');
    assert(
      lifecycle.some((e) => e.phase === 'load'),
      'lifecycle: page load captured via manual init',
    );
    assert(
      errors.some((e) => e.message.includes('uncaught error from webpack-demo')),
      'error: uncaught exception captured without the Vite plugin',
    );
    assert(
      consoles.some((e) => e.level === 'error' && e.args[0]?.includes('webpack-demo')),
      'console: console.error captured without the Vite plugin',
    );
    assert(
      network.some((e) => e.requestUrl.includes('/api/does-not-exist') && e.status === 404),
      'network: failing fetch captured without the Vite plugin',
    );
  } finally {
    await browser.close();
    devServer.kill('SIGTERM');
    daemon.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\nSMOKE FAILED: ${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nSMOKE PASSED: manual webpack integration verified');
  // Child stdio pipes can keep the event loop alive; exit explicitly.
  process.exit(0);
}

// Watchdog: never leave the pipeline hanging on an unexpected stall.
const watchdog = setTimeout(() => {
  console.error('Smoke watchdog: timed out after 120s');
  process.exit(1);
}, 120_000);
watchdog.unref();

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
