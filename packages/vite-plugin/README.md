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

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
