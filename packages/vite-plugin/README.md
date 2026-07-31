# @agentlensjs/vite-plugin

Vite plugin that wires AgentLens into your app during development. It injects the `@agentlensjs/runtime` collector via a virtual module in `serve` mode — no application code changes, zero production footprint.

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { agentlens } from '@agentlensjs/vite-plugin';

export default defineConfig({
  plugins: [agentlens()],
});
```

### Options

```ts
agentlens({
  port: 8631, // daemon port, if you changed it
  enabled: true, // force-disable injection when needed
  captureBodies: false, // opt in to capture request/response bodies (redacted)
  redactKeys: ['idCard', 'mobile'], // project-specific sensitive keys, on top of the built-ins
});
```

## What it does in dev mode

- **Runtime injection** — loads the `@agentlensjs/runtime` collector via a virtual module and reports HMR updates so the daemon's `verify_fix` tool can close the loop.
- **Source attribution** — tags every host element in your JSX with `data-agentlens-source="src/App.tsx:42"`, so any DOM node can be traced back to the exact file and line that rendered it. Component tags are left untouched.

Both apply only to the dev server; production builds are unaffected.

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
