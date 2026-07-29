# @agentlens/runtime

In-browser collector SDK for AgentLens. Captures runtime signals during development and streams them to the local AgentLens daemon over WebSocket:

- **Errors** — uncaught exceptions and unhandled promise rejections
- **Console** — all five levels, with bounded, safely serialized arguments
- **Network** — `fetch` outcomes with status, duration and the initiator stack for caller attribution

Development-only by design: it is injected by `@agentlens/vite-plugin` in `serve` mode and adds zero overhead to production builds.

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
