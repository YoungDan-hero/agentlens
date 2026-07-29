# AgentLens

> DevTools for AI Agents — a runtime feedback layer that gives AI coding agents eyes into the browser.

[![CI](https://github.com/YoungDan-hero/agentlens/actions/workflows/ci.yml/badge.svg)](https://github.com/YoungDan-hero/agentlens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

AI coding agents can write frontend code, but they cannot see what happens in the browser. When a page throws, renders blank, or a request fails, the agent has to guess. AgentLens closes that loop: it captures runtime signals (errors, console output, network activity) during development and exposes them to any MCP-compatible agent (Cursor, Claude Code, ...) with source-level attribution.

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

## Packages

| Package                                              | Description                                        |
| ---------------------------------------------------- | -------------------------------------------------- |
| [`@agentlensjs/vite-plugin`](./packages/vite-plugin) | Injects the runtime SDK into your app in dev mode  |
| [`@agentlensjs/runtime`](./packages/runtime)         | In-browser collector: errors, console, network     |
| [`@agentlensjs/mcp-server`](./packages/mcp-server)   | Daemon that stores events and serves them over MCP |
| [`@agentlensjs/shared`](./packages/shared)           | Wire protocol and shared type definitions          |

## Quick start

1. Add the Vite plugin to your app:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [agentlens()],
});
```

2. Register the MCP server in your agent (e.g. Cursor's `mcp.json`):

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

3. Run `vite dev`, then ask your agent: _"Does the page have any errors right now?"_

A ready-to-run example lives in [`examples/react-demo`](./examples/react-demo), including an automated end-to-end check:

```bash
pnpm build && pnpm --filter react-demo e2e
```

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
- [x] M3a — interaction timeline (cause-and-effect grouping of user actions and their effects)
- [ ] M3b — component tree & render statistics (React / Vue)

## License

[MIT](./LICENSE)
