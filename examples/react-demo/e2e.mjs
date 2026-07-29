// End-to-end verification of the full AgentLens chain:
//   browser signals -> runtime SDK -> WebSocket -> daemon -> MCP tools.
// Usage: pnpm --filter react-demo e2e
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// Dedicated ports so the pipeline never collides with a developer's running
// dev server (5273) or a Cursor-managed daemon (8631).
const VITE_PORT = '5274';
const DAEMON_PORT = '8632';
const DEMO_URL = `http://localhost:${VITE_PORT}/`;
const DAEMON_ENTRY = new URL('../../packages/mcp-server/dist/index.js', import.meta.url).pathname;
const DEMO_DIR = new URL('.', import.meta.url).pathname;
const APP_FILE = new URL('./src/App.tsx', import.meta.url).pathname;

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
  console.log('1/6 Starting AgentLens daemon...');
  const daemon = spawn('node', [DAEMON_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENTLENS_PORT: DAEMON_PORT },
  });
  daemon.stderr.on('data', (d) => process.stdout.write(`      [daemon] ${d}`));

  console.log('2/6 Starting Vite dev server...');
  // Spawn the vite entry directly (not via `pnpm exec`) so kill() reaches
  // the actual server process instead of a wrapper.
  const vite = spawn(
    'node',
    ['node_modules/vite/bin/vite.js', '--strictPort', '--port', VITE_PORT],
    {
      cwd: DEMO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTLENS_PORT: DAEMON_PORT },
    },
  );
  await waitForHttp(DEMO_URL, 30_000);

  console.log('3/6 Launching headless Chrome and triggering signals...');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const originalAppSource = await readFile(APP_FILE, 'utf8');
  try {
    const page = await browser.newPage();
    await page.goto(DEMO_URL, { waitUntil: 'networkidle' });
    // Cold-start dependency optimization makes Vite reload the page once or
    // twice; a warm reload gives the clicks a stable session to land on.
    await sleep(1_500);
    await page.reload({ waitUntil: 'networkidle' });
    await sleep(500);

    // Source attribution: the vite plugin must tag host elements with the
    // original source location before the framework compiles the JSX.
    const sourceAttr = await page.getAttribute('#btn-error', 'data-agentlens-source');
    assert(
      /^src\/App\.tsx:\d+$/.test(sourceAttr ?? ''),
      `attribution: DOM element traced to source (got ${String(sourceAttr)})`,
    );

    for (const id of ['btn-error', 'btn-rejection', 'btn-console', 'btn-404', 'btn-network-fail']) {
      await page.click(`#${id}`);
      await sleep(200);
    }

    console.log('4/6 Querying the daemon over MCP...');
    const client = new McpClient(daemon);
    await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    });
    client.notify('notifications/initialized');

    // Events flow through the runtime's micro-batching transport, so poll
    // until both failed requests have landed instead of guessing a delay.
    let health = await client.callTool('get_page_health');
    const pollDeadline = Date.now() + 15_000;
    while (health.failedRequestCount < 2 && Date.now() < pollDeadline) {
      await sleep(500);
      health = await client.callTool('get_page_health');
    }
    console.log(`      health = ${JSON.stringify(health)}`);

    // Source-map resolution runs asynchronously after ingest; poll until
    // the error frames have been filled in.
    let errors = await client.callTool('get_recent_events', { type: 'error' });
    const framesDeadline = Date.now() + 10_000;
    while (!errors.some((e) => e.frames.length > 0) && Date.now() < framesDeadline) {
      await sleep(500);
      errors = await client.callTool('get_recent_events', { type: 'error' });
    }

    const consoles = await client.callTool('get_recent_events', { type: 'console' });
    const network = await client.callTool('get_recent_events', { type: 'network' });
    const lifecycle = await client.callTool('get_recent_events', { type: 'lifecycle' });

    console.log('5/6 Asserting the captured signals...');
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
      network.some((e) => e.requestUrl.includes('127.0.0.1:9/unreachable') && e.status === null),
      'network: transport failure captured with null status',
    );
    assert(
      errors.some((e) => e.frames.some((f) => f.fileName?.includes('App.tsx') && f.line > 0)),
      'sourcemap: error stack resolved to original source (App.tsx)',
    );
    assert(
      network.some((e) => e.initiatorFrames.some((f) => f.fileName?.includes('App.tsx'))),
      'sourcemap: network initiator resolved to original source',
    );
    assert(health.errorCount >= 2, `health: errorCount >= 2 (got ${health.errorCount})`);
    assert(
      health.failedRequestCount >= 2,
      `health: failedRequestCount >= 2 (got ${health.failedRequestCount})`,
    );

    // Layout snapshot: daemon asks the live page for its box-model tree.
    const snapshot = await client.callTool('get_layout_snapshot');
    const findNode = (node, predicate) => {
      if (!node) return null;
      if (predicate(node)) return node;
      for (const child of node.children) {
        const match = findNode(child, predicate);
        if (match) return match;
      }
      return null;
    };
    assert(snapshot.root?.tag === 'body', 'snapshot: layout tree rooted at body');
    const buttonNode = findNode(
      snapshot.root,
      (n) => n.tag === 'button' && /^src\/App\.tsx:\d+$/.test(n.source ?? ''),
    );
    assert(
      buttonNode !== null && buttonNode.visible && buttonNode.rect.width > 0,
      'snapshot: visible button with source attribution and a real box',
    );

    console.log('6/6 Verifying the fix loop (verify_fix + real HMR)...');
    const uncaught = errors.find((e) => e.subtype === 'uncaught');
    assert(
      typeof uncaught?.fingerprint === 'string' && uncaught.fingerprint.length > 0,
      'verify_fix: error events expose a stable fingerprint',
    );

    // Negative path: without any code change, verification must not pass.
    const noUpdate = await client.callTool('verify_fix', {
      fingerprint: uncaught.fingerprint,
      timeoutMs: 500,
      quietWindowMs: 500,
    });
    assert(
      noUpdate.verified === false && noUpdate.codeUpdateApplied === false,
      'verify_fix: reports "not verified" when no code update arrives',
    );

    // Positive path: touch App.tsx to trigger a real HMR update while
    // verify_fix is waiting; the error does not recur, so it verifies.
    const pendingVerify = client.callTool('verify_fix', {
      fingerprint: uncaught.fingerprint,
      timeoutMs: 6_000,
      quietWindowMs: 1_500,
    });
    await sleep(1_000);
    await writeFile(APP_FILE, originalAppSource + '\n// e2e-hmr-touch\n', 'utf8');
    const verify = await pendingVerify;
    console.log(`      verify_fix = ${JSON.stringify(verify)}`);
    assert(
      verify.codeUpdateApplied === true,
      'verify_fix: HMR update reported by the runtime was observed',
    );
    assert(verify.verified === true, 'verify_fix: fix verified after HMR with no recurrence');
  } finally {
    await writeFile(APP_FILE, originalAppSource, 'utf8');
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
  console.error('E2E watchdog: timed out after 120s');
  process.exit(1);
}, 120_000);
watchdog.unref();

main().catch((error) => {
  console.error('E2E crashed:', error);
  process.exit(1);
});
