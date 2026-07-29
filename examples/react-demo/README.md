# AgentLens React Demo

A minimal React app wired with `@agentlensjs/vite-plugin`. Five buttons emit the runtime signals AgentLens captures: an uncaught error, an unhandled promise rejection, a `console.error`, a 404 response, and a transport-level network failure.

## Run interactively

```bash
# Terminal 1: start the daemon
node ../../packages/mcp-server/dist/index.js

# Terminal 2: start the app
pnpm dev
```

Open http://localhost:5273, click some buttons, then ask your MCP-connected agent: _"Does the page have any errors right now?"_

## Run the automated end-to-end check

Verifies the full chain (browser → runtime SDK → WebSocket → daemon → MCP tools) using headless Chrome:

```bash
pnpm --filter react-demo e2e
```

Requires Google Chrome and a prior `pnpm build` at the repository root.
