<script setup lang="ts">
import { ref } from 'vue';

const log = ref<string[]>([]);
// Exercised by the action-channel E2E: perform_action must drive v-model.
const visitorName = ref('');

function record(message: string): void {
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());
  log.value = [`[${time}] ${message}`, ...log.value].slice(0, 8);
}

function throwUncaughtError(): void {
  record('emitted: uncaught error (see DevTools console / AgentLens)');
  throw new Error('Demo: uncaught error from button click');
}

function rejectPromise(): void {
  record('emitted: unhandled promise rejection');
  void Promise.reject(new Error('Demo: unhandled promise rejection'));
}

function logConsoleError(): void {
  record('emitted: console.error with payload');
  console.error('Demo: console.error with payload', { userId: 42, reason: 'invalid state' });
}

function fetchMissingEndpoint(): void {
  record('emitted: GET /api/does-not-exist (404)');
  void fetch('/api/does-not-exist');
}

async function fetchUnreachableHost(): Promise<void> {
  try {
    // Port 9 (discard) is on every browser's blocked-port list, so the fetch
    // fails at the transport level instantly — no DNS lookup, no timeout.
    await fetch('http://127.0.0.1:9/unreachable');
  } catch {
    // Expected: transport-level failure is what we want AgentLens to capture.
  }
}

function fetchUnreachable(): void {
  record('emitted: GET http://127.0.0.1:9/unreachable (transport failure)');
  void fetchUnreachableHost();
}

function xhrMissingEndpoint(): void {
  record('emitted: XHR GET /api/xhr-missing (404)');
  // Deliberately raw XHR: axios' default browser adapter goes through
  // XMLHttpRequest, and AgentLens must capture that path too.
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/xhr-missing');
  xhr.send();
}

function sendBeacon(): void {
  record('emitted: sendBeacon POST /api/beacon (fire-and-forget)');
  // The password field demonstrates body redaction: with captureBodies on,
  // the captured event shows [REDACTED] instead of the value.
  navigator.sendBeacon('/api/beacon', JSON.stringify({ step: 'checkout', password: 'hunter2' }));
}
</script>

<template>
  <main class="page">
    <h1>AgentLens Vue Demo</h1>
    <p>
      Each button emits a runtime signal. The page itself stays quiet by design — the signals
      surface in DevTools and in the AgentLens daemon. Ask your AI agent
      <em>&ldquo;does the page have any errors right now?&rdquo;</em> and it will answer via the
      AgentLens MCP server.
    </p>

    <button id="btn-error" class="action" @click="throwUncaughtError">
      1. Throw an uncaught error
    </button>
    <button id="btn-rejection" class="action" @click="rejectPromise">
      2. Trigger an unhandled promise rejection
    </button>
    <button id="btn-console" class="action" @click="logConsoleError">3. Log a console.error</button>
    <button id="btn-404" class="action" @click="fetchMissingEndpoint">
      4. Fetch a 404 endpoint
    </button>
    <button id="btn-network-fail" class="action" @click="fetchUnreachable">
      5. Fetch an unreachable host
    </button>
    <button id="btn-xhr" class="action" @click="xhrMissingEndpoint">
      6. XHR a 404 endpoint (axios-style)
    </button>
    <button id="btn-beacon" class="action" @click="sendBeacon">
      7. Send a beacon (fire-and-forget)
    </button>

    <label class="visitor">
      Visitor name
      <input id="visitor-name" v-model="visitorName" type="text" placeholder="Type your name" />
    </label>
    <p id="visitor-greeting">
      {{ visitorName === '' ? 'Hello, stranger.' : `Hello, ${visitorName}!` }}
    </p>

    <section id="signal-log" class="log" aria-live="polite">
      {{ log.length === 0 ? 'No signals emitted yet — click a button above.' : log.join('\n') }}
    </section>
  </main>
</template>

<style scoped>
.page {
  font-family: system-ui, sans-serif;
  max-width: 640px;
  margin: 4rem auto;
  padding: 0 1rem;
  line-height: 1.6;
}

.action {
  display: block;
  width: 100%;
  margin: 0.5rem 0;
  padding: 0.75rem 1rem;
  font-size: 1rem;
  border-radius: 8px;
  border: 1px solid #d0d0d0;
  background: #fafafa;
  cursor: pointer;
  text-align: left;
}

.log {
  margin-top: 1.5rem;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  background: #f4f4f5;
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
}
</style>
