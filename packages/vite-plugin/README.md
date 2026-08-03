# @agentlensjs/vite-plugin

Vite plugin that wires AgentLens into your app during development. It injects the `@agentlensjs/runtime` collector via a virtual module in `serve` mode — no application code changes, zero production footprint.

## Usage

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

### Options

```ts
agentlens({
  port: 8631, // daemon port, if you changed it
  enabled: true, // force-disable injection when needed
  captureBodies: false, // opt in to capture request/response bodies (redacted)
  redactKeys: ['idCard', 'mobile'], // project-specific sensitive keys, on top of the built-ins
  allowActions: false, // opt in to agent-driven actions (perform_action / perform_actions / replay_error_path)
  isCustomElement: (tag) => tag.startsWith('my-'), // mirror @vitejs/plugin-vue so custom elements get attributed too
});
```

## What it does in dev mode

- **Runtime injection** — loads the `@agentlensjs/runtime` collector via a virtual module and reports HMR updates so the daemon's `verify_fix` tool can close the loop.
- **Source attribution** — tags every native element in Vue SFC templates (`data-agentlens-source="src/App.vue:42"`) and every host element in JSX (`src/App.tsx:42`), so any DOM node can be traced back to the exact file and line that rendered it. Component tags are left untouched — an attribute there would become a prop instead of landing on a DOM node. The attribution also powers the reverse direction: `find_elements_by_source` lists what a file renders, and action locators stay stable across refactors.

Both apply only to the dev server; production builds are unaffected.

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
