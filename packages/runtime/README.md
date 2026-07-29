# @agentlensjs/runtime

In-browser collector SDK for AgentLens. Captures runtime signals during development and streams them to the local AgentLens daemon over WebSocket:

- **Errors** — uncaught exceptions and unhandled promise rejections
- **Console** — all five levels, with bounded, safely serialized arguments
- **Network** — `fetch` and `XMLHttpRequest` (axios included) outcomes with status, duration and the initiator stack for caller attribution
- **Interactions** — clicks, debounced inputs and form submits, attributed to the source line that rendered the element
- **Lifecycle** — page load, SPA route changes (History API), HMR updates and unload
- **Layout snapshots** — answers daemon requests with a structured box-model tree of the page

Events are micro-batched over a single WebSocket with bounded buffering and exponential-backoff reconnection. Pending events are flushed on page hide so the last moments of a session are not lost.

Development-only by design: it is injected by `@agentlensjs/vite-plugin` in `serve` mode and adds zero overhead to production builds.

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
