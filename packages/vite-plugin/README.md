# @agentlens/vite-plugin

Vite plugin that wires AgentLens into your app during development. It injects the `@agentlens/runtime` collector via a virtual module in `serve` mode — no application code changes, zero production footprint.

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { agentlens } from '@agentlens/vite-plugin';

export default defineConfig({
  plugins: [agentlens()],
});
```

See the [AgentLens monorepo](https://github.com/agentlens/agentlens) for full documentation.
