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
- **Network** — every `fetch` and `XMLHttpRequest` (axios included) with method, status, duration, and the source location that initiated the request
- **User interactions** — clicks, debounced inputs and form submits, each attributed to the source line that rendered the element
- **Lifecycle** — page loads, SPA route changes, HMR updates and unloads

**Signal intelligence** (in the daemon):

- **Error deduplication** — identical errors fold into one record with an occurrence counter, so a render-loop error storm cannot flush useful signals out of the buffer
- **Session isolation** — every page load / tab is a separate session; queries scope to the most recently active one by default
- **Source attribution** — the Vite plugin stamps JSX elements with `data-agentlens-source="file:line"`, so DOM nodes, clicks and layout boxes all trace back to code

**Six MCP tools** for the agent:

| Tool                       | What it answers                                                      |
| -------------------------- | -------------------------------------------------------------------- |
| `get_page_health`          | "Is the page healthy right now?" — errors, failed requests, activity |
| `get_recent_events`        | "Show me the errors / logs / requests" — filterable drill-down       |
| `get_interaction_timeline` | "What did the user do to cause this?" — cause-and-effect grouping    |
| `get_layout_snapshot`      | "What does the page look like?" — structured box tree, no screenshot |
| `verify_fix`               | "Did my fix work?" — waits for HMR, watches whether the error recurs |
| `list_sessions`            | "Which tabs / reloads are connected?" — session management           |

## Use cases

- **Autonomous debugging** — the agent edits code, checks `get_page_health`, sees a new error with a source-mapped stack pointing at `src/App.tsx:42`, fixes it, and confirms with `verify_fix` — without you touching DevTools.
- **"It's broken after my change"** — `get_interaction_timeline` shows the click on the submit button, the 500 response it triggered, and the unhandled rejection that followed, as one causal group.
- **Layout and styling issues** — `get_layout_snapshot` gives the agent a structured view of every box (position, size, visibility, overflow, text) with the source line that rendered it, so "the sidebar overflows" becomes an addressable fact instead of a guess.
- **Closing the fix loop** — after editing, the agent calls `verify_fix` with the error's fingerprint; the daemon waits for the HMR update to reach the browser and reports whether the error recurred.

## Getting started

### 1. Install the Vite plugin

```bash
pnpm add -D @agentlensjs/vite-plugin
# or: npm install -D @agentlensjs/vite-plugin
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [agentlens()],
});
```

The plugin only applies in `serve` mode — production builds are untouched. Options:

```ts
agentlens({
  port: 8631, // daemon port, if you changed it
  enabled: true, // force-disable injection when needed
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

Run `vite dev` and open the page. The runtime connects to the daemon automatically. Then ask your agent things like:

- _"Does the page have any errors right now?"_
- _"What happened when I clicked the checkout button?"_
- _"Is anything overflowing on the page?"_
- _"I pushed a fix — verify that the error is gone."_

A ready-to-run example lives in [`examples/react-demo`](./examples/react-demo), including an automated end-to-end check:

```bash
pnpm build && pnpm --filter react-demo e2e
```

## Packages

| Package                                              | Description                                                |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| [`@agentlensjs/vite-plugin`](./packages/vite-plugin) | Injects the runtime and stamps JSX with source attribution |
| [`@agentlensjs/runtime`](./packages/runtime)         | In-browser collector SDK                                   |
| [`@agentlensjs/mcp-server`](./packages/mcp-server)   | Daemon: event store, stack resolution, MCP tools           |
| [`@agentlensjs/shared`](./packages/shared)           | Wire protocol and shared type definitions                  |

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

## Known limitations

- **Vite only** — the runtime is injected via `@agentlensjs/vite-plugin`; other bundlers are not supported yet.
- **No `sendBeacon` / WebSocket capture** — network capture covers `fetch` and `XMLHttpRequest`; beacon and socket traffic is not recorded.
- **In-memory store** — the daemon keeps events in a bounded in-memory buffer; restarting the daemon clears history. This is by design for a dev-time tool.
- **No iframe / shadow DOM traversal** — layout snapshots cover the top-level document only.

## License

[MIT](./LICENSE)
