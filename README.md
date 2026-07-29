# AgentLens

> DevTools for AI Agents — a runtime feedback layer that gives AI coding agents eyes into the browser.

[![CI](https://github.com/agentlens/agentlens/actions/workflows/ci.yml/badge.svg)](https://github.com/agentlens/agentlens/actions/workflows/ci.yml)
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

| Package                                            | Description                                        |
| -------------------------------------------------- | -------------------------------------------------- |
| [`@agentlens/vite-plugin`](./packages/vite-plugin) | Injects the runtime SDK into your app in dev mode  |
| [`@agentlens/runtime`](./packages/runtime)         | In-browser collector: errors, console, network     |
| [`@agentlens/mcp-server`](./packages/mcp-server)   | Daemon that stores events and serves them over MCP |
| [`@agentlens/shared`](./packages/shared)           | Wire protocol and shared type definitions          |

## Quick start

1. Add the Vite plugin to your app:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { agentlens } from '@agentlens/vite-plugin';

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
      "args": ["-y", "@agentlens/mcp-server"]
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

Requires Node.js >= 20.19 and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build      # build all packages
pnpm test       # run tests
pnpm lint       # lint
pnpm typecheck  # type-check all packages
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## Roadmap

- [x] M1 — error / console / network capture, `get_page_health`, `get_recent_events`, E2E-verified chain
- [ ] M2 — structured layout snapshots, `data-source` attribution, `verify_fix`
- [ ] M3 — component tree & render statistics (React / Vue), interaction timeline

## License

[MIT](./LICENSE)
