# vue-demo

AgentLens end-to-end demo on **Vue 3**: a single-page app whose buttons emit
runtime signals — uncaught errors, unhandled rejections, console output,
failing `fetch`/XHR requests, beacons — that AgentLens captures and exposes
to AI agents over MCP.

Source attribution works on the SFC template: every native element carries a
`data-agentlens-source="src/App.vue:<line>"` attribute injected by
`@agentlensjs/vite-plugin` before `@vitejs/plugin-vue` compiles the template.

## Run it

```bash
pnpm --filter vue-demo dev   # dev server on http://localhost:5276
pnpm --filter vue-demo e2e   # full-chain smoke test (needs Chrome)
```

The E2E script spawns an isolated daemon (port 8634) and dev server
(port 5277), drives the page with headless Chrome and asserts the whole
chain through real MCP tool calls — including template source attribution,
sourcemap resolution back to `App.vue` and the `verify_fix` HMR loop.
