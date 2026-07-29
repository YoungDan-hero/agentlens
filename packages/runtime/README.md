# @agentlens/runtime

In-browser collector SDK for AgentLens. Captures runtime signals (uncaught errors, unhandled rejections, and more) during development and streams them to the local AgentLens daemon over WebSocket.

Development-only by design: it is injected by `@agentlens/vite-plugin` in `serve` mode and adds zero overhead to production builds.

See the [AgentLens monorepo](https://github.com/agentlens/agentlens) for full documentation.
