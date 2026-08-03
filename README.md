# AgentLens

> DevTools for AI Agents — a runtime feedback layer that gives AI coding agents eyes into the browser.

[![CI](https://github.com/YoungDan-hero/agentlens/actions/workflows/ci.yml/badge.svg)](https://github.com/YoungDan-hero/agentlens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40agentlensjs%2Fmcp-server)](https://www.npmjs.com/package/@agentlensjs/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**[中文文档](./README.zh-CN.md)**

AI coding agents can write frontend code, but they cannot see what happens in the browser. When a page throws, renders blank, or a request fails, the agent has to guess — or ask you to paste console output back and forth. AgentLens closes that loop: it captures runtime signals during development and exposes them to any MCP-compatible agent (Cursor, Claude Code, ...) with source-level attribution.

```
┌─────────────┐  WebSocket  ┌───────────────┐  MCP (stdio)  ┌─────────┐
│   Browser    │ ──────────▶ │  AgentLens     │ ◀───────────▶ │  Agent  │
│  runtime SDK │             │  daemon        │               │ (Cursor)│
└─────────────┘             └───────────────┘               └─────────┘
       ▲ injected by
┌─────────────┐
│  Vite plugin │
└─────────────┘
```

## Features

**Runtime signal capture** (zero code changes, dev-mode only):

- **Errors** — uncaught exceptions and unhandled promise rejections, with stack traces resolved back to your original source files via source maps
- **Console** — all five levels (`log` / `info` / `warn` / `error` / `debug`) with bounded, safely serialized arguments
- **Network** — every `fetch`, `XMLHttpRequest` (axios included), WebSocket connection and `sendBeacon` call with method, status, duration, and the source location that initiated it; request/response bodies optionally captured (opt-in, redacted)
- **Performance** — Web Vitals (FCP, LCP, CLS, INP, TTFB) with web.dev ratings plus long tasks, via the native `PerformanceObserver` — no extra dependency
- **User interactions** — clicks, debounced inputs and form submits, each attributed to the source line that rendered the element
- **Lifecycle** — page loads, SPA route changes, HMR updates and unloads

**Signal intelligence** (in the daemon):

- **Error deduplication** — identical errors fold into one record with an occurrence counter, so a render-loop error storm cannot flush useful signals out of the buffer
- **Session isolation** — every page load / tab is a separate session; queries scope to the most recently active one by default
- **Source attribution** — the Vite plugin stamps Vue SFC template elements and JSX host elements with `data-agentlens-source="file:line"`, so DOM nodes, clicks and layout boxes all trace back to code

**Browser action channel** (opt-in):

- **Agent-driven testing** — with `allowActions: true`, the agent can click, type, pick select options, scroll and navigate (same origin only) inside your real dev session — no separate browser, no cold start, with every AgentLens signal available for assertions
- **Batch sequences** — `perform_actions` runs up to 20 steps in one round-trip, each with an optional local wait condition (element visible / attached / hidden), so a fill-the-form-and-submit flow costs one agent call instead of five
- **One-command replay** — `replay_error_path` turns the interactions that preceded an error into a script and re-runs it, comparing the error fingerprint's occurrence count before and after: the fastest possible "did my fix work?" answer
- **Human input wins** — actions are refused (and running sequences aborted) while you are actively using the page; the agent simply retries later
- **Audit trail** — every synthetic interaction is captured with a `synthetic: true` marker, and touched elements flash a highlight outline

**Thirteen MCP tools** for the agent:

| Tool                       | What it answers                                                                   |
| -------------------------- | --------------------------------------------------------------------------------- |
| `get_page_health`          | "Is the page healthy right now?" — errors, failed requests, activity              |
| `get_error_context`        | "Why did this error happen?" — one-call root-cause bundle                         |
| `get_recent_events`        | "Show me the errors / logs / requests" — filterable by type, time and source file |
| `get_interaction_timeline` | "What did the user do to cause this?" — cause-and-effect grouping                 |
| `get_layout_snapshot`      | "What does the page look like?" — structured box tree, no screenshot              |
| `find_elements_by_source`  | "What does src/App.vue render right now?" — reverse source lookup                 |
| `get_performance`          | "Why is the page slow?" — Web Vitals with ratings, long-task load                 |
| `perform_action`           | "Click that button / fill that form for me" — drives the live page (opt-in)       |
| `perform_actions`          | "Run these five steps" — batch sequence with local wait conditions (opt-in)       |
| `replay_error_path`        | "Reproduce that error" — replays the path that led to it, checks recurrence       |
| `wait_for_idle`            | "Has the app finished reacting?" — blocks until the event stream settles          |
| `verify_fix`               | "Did my fix work?" — waits for HMR, watches whether the error recurs              |
| `list_sessions`            | "Which tabs / reloads are connected?" — sessions with live focus state            |

## Use cases

- **Autonomous debugging** — the agent edits code, checks `get_page_health`, sees a new error with a source-mapped stack pointing at `src/App.vue:42`, fixes it, and confirms with `verify_fix` — without you touching DevTools.
- **Root-cause analysis in one call** — `get_error_context` bundles an error with the interactions that preceded it (each with the source location of the element), the network requests and console warnings in the same time window, and the session's Web Vitals — no manual correlation across tools.
- **"It's broken after my change"** — `get_interaction_timeline` shows the click on the submit button, the 500 response it triggered, and the unhandled rejection that followed, as one causal group.
- **Layout and styling issues** — `get_layout_snapshot` gives the agent a structured view of every box (position, size, visibility, overflow, text) with the source line that rendered it, so "the sidebar overflows" becomes an addressable fact instead of a guess.
- **Performance regressions** — `get_performance` reports the current Web Vitals with their web.dev ratings and the long-task pressure, so "the page feels slow" turns into "INP is 620 ms (poor) and there are 14 long tasks totalling 2.1 s".
- **Closing the fix loop** — after editing, the agent calls `verify_fix` with the error's fingerprint; the daemon waits for the HMR update to reach the browser and reports whether the error recurred.
- **In-session automated testing** — with actions enabled, the agent reproduces the bug itself: `perform_action` clicks the button that crashed (located by `data-agentlens-source`, stable across refactors), `wait_for_idle` lets the app settle, and the action result reports the errors and failed requests it triggered — a full regression check without leaving your dev session.
- **Scripted flows in one call** — `perform_actions` fills the form, waits for the conditional field to appear (`waitFor`), and submits — one agent round-trip instead of one per step, with the break point (`stoppedAt`, `stopReason`) reported if anything fails along the way.
- **Fix verification by replay** — `replay_error_path` derives the reproduction script from the interactions that preceded the error (dry run first, so you can review and fill in typed values), executes it, and answers with `errorRecurred: true/false` by comparing fingerprint occurrence counts.
- **Editing a component? See its runtime output** — `find_elements_by_source` lists the elements a source file renders on the live page, and `get_recent_events` with `source: "src/Checkout.vue"` returns just the errors, interactions and requests attributed to that file.
- **Multiple tabs open?** — the runtime reports focus and visibility, the daemon targets snapshots and actions at the page you are actually looking at, and `list_sessions` shows the live focus state per session.

## Getting started

### 1. Install the Vite plugin

```bash
pnpm add -D @agentlensjs/vite-plugin
# or: npm install -D @agentlensjs/vite-plugin
```

```ts
// vite.config.ts — Vue
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [vue(), agentlens()],
});
```

```ts
// vite.config.ts — React
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [react(), agentlens()],
});
```

Source attribution covers both ecosystems: Vue SFC templates (`.vue`) and JSX/TSX host elements get `data-agentlens-source="file:line"` stamps automatically. The plugin only applies in `serve` mode — production builds are untouched. Options:

```ts
agentlens({
  port: 8631, // daemon port, if you changed it
  enabled: true, // force-disable injection when needed
  captureBodies: false, // opt in to capture request/response bodies (redacted)
  redactKeys: ['idCard', 'mobile'], // project-specific sensitive keys, on top of the built-ins
  allowActions: false, // opt in to let the agent drive the page via perform_action
  isCustomElement: (tag) => tag.startsWith('my-'), // mirror @vitejs/plugin-vue so custom elements get attributed too
});
```

### 2. Register the MCP server in your agent

**Cursor** (`.cursor/mcp.json` in your project, or global settings):

```json
{
  "mcpServers": {
    "agentlens": {
      "command": "npx",
      "args": ["-y", "@agentlensjs/mcp-server"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add agentlens -- npx -y @agentlensjs/mcp-server
```

The daemon starts automatically with your agent and listens for browser connections on `ws://localhost:8631` (loopback only). To change the port, set the `AGENTLENS_PORT` environment variable on the daemon and pass the same value to the plugin's `port` option.

### 3. Develop as usual

Run `npm run dev` (your project's Vite dev-server script) and open the page. The runtime connects to the daemon automatically. Then ask your agent things like:

- _"Does the page have any errors right now?"_
- _"What happened when I clicked the checkout button?"_
- _"Is anything overflowing on the page?"_
- _"I pushed a fix — verify that the error is gone."_

Ready-to-run examples live in [`examples/vue-demo`](./examples/vue-demo) and [`examples/react-demo`](./examples/react-demo), each with an automated end-to-end check:

```bash
pnpm build && pnpm --filter vue-demo e2e
```

### Using without Vite

The Vite plugin is a convenience, not a requirement. The collector SDK is plain browser code — on any other toolchain (Webpack, Next.js, Nuxt with Webpack, ...), install it directly and initialize it in your client entry module:

```bash
npm install -D @agentlensjs/runtime
```

```ts
// client entry (e.g. src/main.tsx) — dev only
if (process.env.NODE_ENV === 'development') {
  void import('@agentlensjs/runtime').then(({ init }) => {
    init();
  });
}
```

The dynamic import behind the env check keeps the SDK out of production bundles entirely. `init` accepts:

```ts
init({
  endpoint: 'ws://localhost:8631/agentlens', // match AGENTLENS_PORT if you changed it
  captureBodies: false, // opt in to request/response bodies (redacted)
  redactKeys: ['idCard', 'mobile'], // project-specific sensitive keys
  allowActions: false, // opt in to let the agent drive the page via perform_action
});
```

One caveat inherent to this pattern: collectors only exist once the dynamically imported chunk has loaded, so signals fired synchronously during application startup are not captured. This exact integration is exercised by an automated smoke test in [`examples/webpack-demo`](./examples/webpack-demo).

Everything above works with manual setup — errors, console, network, performance, interactions, layout snapshots, the action channel and all thirteen MCP tools — with two degradations (additionally, `find_elements_by_source` and the `source` locators depend on the attribution attribute, so fall back to selector/text locators):

- **Source attribution** — `data-agentlens-source` is stamped by the Vite plugin's template/JSX transform, so without it, interactions and layout boxes describe elements by tag / id / class instead of `file:line`.
- **`verify_fix`** — the daemon accepts either an HMR signal or a full page reload as proof that new code reached the browser. Reloads work out of the box; to get the faster HMR path, wire your bundler's hot API to `reportHmrUpdate`:

```ts
// webpack 5 — optional, reloads work without it
if (process.env.NODE_ENV === 'development') {
  void import('@agentlensjs/runtime').then(({ init }) => {
    const client = init();
    import.meta.webpackHot?.addStatusHandler((status) => {
      if (status === 'idle') client.reportHmrUpdate();
    });
  });
}
```

For Next.js, run the snippet on the client only — e.g. in [`instrumentation-client.ts`](https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client) (Next 15.3+) or a `'use client'` component mounted in the root layout.

### MCP tools in detail

**`get_page_health`** — the tool an agent should call first. Returns a health overview of the last 5 minutes: deduplicated error count, total occurrences including folded repeats, failed request count, and last-activity time. Scopes to the most recently active session by default; pass `sessionId` to pick one.

**`get_recent_events`** — the drill-down query. Filters by `type` (error / console / network / lifecycle / interaction / performance), `sessionId`, `sinceMs` (timestamp lower bound), `limit` (default 50, max 200), and `source` (source-file filter: `src/App.vue`, or exact-line `src/App.vue:42`; matches interactions on elements from that file, errors whose resolved stack passes through it, and requests initiated by it). Returns newest-first events. Error events carry a `fingerprint` and sourcemap-resolved `frames`.

**`get_error_context`** — the root-cause bundle. Pass an error `fingerprint` or event `id` (defaults to the latest error) and get, in one call: the folded error record (with resolved stack), the user interactions preceding its last occurrence (with element source attribution, up to 5), network requests and console warnings/errors in the same window (up to 10 each), and the session's Web Vitals profile. `lookbackMs` controls the lookback window (default 15 s). The preferred entry point for diagnosing a single error instead of manually correlating across tools.

**`get_interaction_timeline`** — the causal view. Groups user interactions (click / input / submit, each with element source attribution) with the errors, requests, and logs that follow them. `windowMs` controls the attribution window (default 3000 ms); the window is cut short by the next interaction. Events belonging to no interaction land in `background`.

**`get_layout_snapshot`** — a live layout snapshot. Asks the browser for a structured box tree: each visible element's tag, viewport rect, visibility, overflow state, direct text, and its `data-agentlens-source` attribution. Node budget defaults to 800; `truncated` marks overflow.

**`get_performance`** — the performance profile. Returns the latest reading per Web Vital in the current session (FCP / LCP / CLS / INP / TTFB, each with the web.dev rating good / needs-improvement / poor) plus a long-task summary (count, total duration, worst one, recent list). Good for "why is the page slow" and for re-checking metrics after an optimization.

**`perform_action`** — the browser action channel (requires the app to opt in with `allowActions: true`). Lets the agent drive the page inside the user's real dev session: `click`, `input` (compatible with React controlled components and Vue v-model), `select`, `scroll`, and same-origin `navigate`. Locate elements by one of `source` (the `file:line` value of `data-agentlens-source`, most stable across refactors), `selector` (CSS), or `text` (visible text, deepest match); disambiguate multiple matches with `nth`. After dispatch the runtime waits for the page to settle and returns the element actually hit, the settle time, and the counts of errors / failed requests / console errors the action triggered. Safety: actions are refused while the user has produced real input within the last 1.5 s (just retry later), only one action runs at a time, cross-origin navigation is always refused, every synthetic interaction is stored with a `synthetic: true` audit marker, and the acted-on element flashes a highlight outline.

**`perform_actions`** — batch action sequences (also requires `allowActions: true`). Executes up to 20 steps in order within one round-trip; each step may declare a local `waitFor` condition (`source` / `selector` / `text` locator + `visible` / `attached` / `hidden` state + `timeoutMs`) that the runtime polls inside the browser, so async UI (options still loading, fields appearing on change) no longer costs an agent round-trip. Stops at the first failure — and immediately when the user starts interacting — returning the break point (`stoppedAt`), the reason (`stopReason`), per-step results, accumulated effects, and the final URL; the agent replans from the break point. `navigate` is only allowed as the last step (a full page load destroys the executing page).

**`find_elements_by_source`** — the reverse source query. Pass a source path (`src/App.vue`, or exact `src/App.vue:42`) and get every element that file currently renders on the page (tag, id, visible text, visibility, exact `file:line` attribution), capped at 100 with `truncated`. Use it to see what a component you just edited looks like at runtime, or to find an element for `perform_action`.

**`replay_error_path`** — one-call error replay. Derives an action-sequence script from the real human interactions before an error (agent-synthetic interactions are filtered out): clicks locate by `source` (stable across refactors); input steps are marked `needsValue` because **input values are never captured**, so the caller supplies them. Dry run by default, returning the script for review; pass `dryRun: false` (with `values: {"0": "text"}` filling the inputs) to actually execute. Afterwards it compares the error fingerprint's occurrence count and returns `errorRecurred` — run it once after a fix to know directly whether the error came back.

**`wait_for_idle`** — waits for the app to go quiet. Blocks until the session's event stream has been silent for `quietMs` (default 1 s) or `timeoutMs` (default 10 s) elapses. Call it after `perform_action` and before asserting page state, so you never query while the app is still reacting.

**`verify_fix`** — the fix-verification loop. Pass an error's `fingerprint` (from `get_recent_events`); the tool works in two phases: first it waits for new code to reach the browser (HMR or full reload, up to `timeoutMs`, default 10 s), then it watches for the fingerprint to recur within a `quietWindowMs` (default 3 s) quiet window. Note: errors triggered only by user interaction need that interaction re-triggered for full confirmation — the result says so explicitly, and the agent can now re-trigger it directly with `perform_action`.

**`list_sessions`** — lists every known session (one per page load / tab), ordered by recent activity. Sessions still connected carry live focus state: `connected`, `visible` (page visible), `focused` (the page the user is looking at). The runtime reports visibility and focus changes continuously, and the daemon prefers the focused page when picking the target session for snapshots and actions — with several tabs open, the agent drives the one in front of you. Pass `sessionId` to scope explicitly.

## Packages

| Package                                              | Description                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| [`@agentlensjs/vite-plugin`](./packages/vite-plugin) | Injects the runtime; stamps Vue templates and JSX with source attribution |
| [`@agentlensjs/runtime`](./packages/runtime)         | In-browser collector SDK                                                  |
| [`@agentlensjs/mcp-server`](./packages/mcp-server)   | Daemon: event store, stack resolution, MCP tools                          |
| [`@agentlensjs/shared`](./packages/shared)           | Wire protocol and shared type definitions                                 |

## Development

Requires Node.js >= 22.13 (pnpm 11 depends on the `node:sqlite` builtin) and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build      # build all packages
pnpm test       # run tests
pnpm lint       # lint
pnpm typecheck  # type-check all packages
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## Roadmap

- [x] M1 — error / console / network capture, source-mapped stack attribution, `get_page_health`, `get_recent_events`, E2E-verified chain
- [x] M2 — structured layout snapshots, `data-source` attribution, `verify_fix`
- [x] M3 — interaction timeline (cause-and-effect grouping of user actions and their effects)
- [x] M4 — first-class Vue support: SFC template source attribution, Vue demo in the E2E matrix
- [x] M5a — one-call error root-cause bundle (`get_error_context`)
- [x] M5b — browser action channel: agent-driven in-session automated testing (opt-in)
- [x] M6 — fix-verification engine: session focus signal, reverse source lookup (`find_elements_by_source`, `source` event filter), batch sequences with wait conditions (`perform_actions`), one-command error replay (`replay_error_path`)

## Privacy & data safety

AgentLens is a dev-time tool designed so that sensitive data cannot leave your machine:

- **Loopback only** — the daemon binds to `127.0.0.1`; nothing is reachable from the network, and nothing is ever uploaded anywhere.
- **Origin-gated ingest** — loopback binding does not stop _pages_, so the daemon additionally rejects WebSocket handshakes from non-local origins. A malicious website open in your browser cannot connect and inject forged events into your agent's context. Extra origins can be trusted via `AGENTLENS_ALLOWED_ORIGINS`.
- **Schema-validated events** — every ingested event is deep-validated field-by-field; malformed payloads never reach the store (or your agent).
- **Headers are never captured** — request/response headers (`Authorization`, `Cookie`, ...) are not collected at all, by design.
- **Bodies are opt-in and redacted** — request/response bodies ship only with `captureBodies: true`, and even then sensitive fields (`password`, `token`, `secret`, `authorization`, ...) are replaced with `[REDACTED]` inside the browser, before anything leaves the page. Add project-specific keys (e.g. `idCard`) with the `redactKeys` option. Bodies are size-capped (4 KB).
- **URLs are redacted by default** — sensitive query parameter values (`?token=...`, `?apiKey=...`) are stripped on every network event.
- **Form values are never captured** — interaction events record the element, not what was typed into it.
- **The action channel is off by default** — `perform_action`, `perform_actions` and `replay_error_path` only work when the app opts in with `allowActions: true`. Even then: actions are refused (and running sequences aborted) while you are actively interacting (human input always wins), navigation is confined to the app's own origin, and every synthetic interaction lands in the store with a `synthetic: true` audit marker. Typed input values are never captured, so replay scripts ask you (or the agent) to supply them explicitly.

Found a vulnerability? Please report it privately — see [SECURITY.md](./SECURITY.md).

## Design decisions

### No persistence, on purpose

The daemon keeps events in a bounded in-memory buffer; restarting it clears all history. This is a deliberate decision, not a missing feature:

- **Stale runtime data is worse than no data.** Events describe the code as it was at capture time. After a restart the code has usually changed — line numbers drift, source maps are rebuilt — so a restored error would point the agent at code that no longer exists. For a fix loop, misleading history is strictly worse than an empty buffer.
- **Restarts don't happen mid-session.** The daemon lives and dies with your MCP client (Cursor, Claude Code); it is not a long-running service that needs crash recovery.
- **Memory-only is a privacy guarantee.** Nothing is ever written to disk; every captured signal disappears with the process. Persisting events would create files containing request data that need permissions, retention and cleanup — a real cost for negligible benefit.
- **AgentLens is a feedback loop, not an APM.** Cross-session error history is a monitoring product's job (Sentry and friends). Keeping the daemon stateless keeps the scope honest.

## Known limitations

- **Vite-only** — on other bundlers, use the [manual setup](#using-without-vite); you keep all signals and tools, but lose `file:line` source attribution.
- **WebSocket frames are not recorded** — connection attempts (open/failure) are captured, message payloads are not.
- **In-memory store** — restarting the daemon clears history; see [Design decisions](#design-decisions) for why this stays.
- **No iframe / shadow DOM traversal** — layout snapshots cover the top-level document only.

## License

[MIT](./LICENSE)
