# @agentlensjs/runtime

In-browser collector SDK for AgentLens. Captures runtime signals during development and streams them to the local AgentLens daemon over WebSocket:

- **Errors** — uncaught exceptions and unhandled promise rejections
- **Console** — all five levels, with bounded, safely serialized arguments
- **Network** — `fetch`, `XMLHttpRequest` (axios included), WebSocket connections and `sendBeacon` calls with status, duration and the initiator stack for caller attribution; request/response bodies optionally captured (opt-in via `captureBodies`, redacted and size-capped)
- **Performance** — Web Vitals (FCP, LCP, CLS, INP, TTFB with web.dev ratings) and long tasks via the native `PerformanceObserver`
- **Interactions** — clicks, debounced inputs and form submits, attributed to the source line that rendered the element
- **Lifecycle** — page load, SPA route changes (History API), HMR updates and unload
- **Layout snapshots** — answers daemon requests with a structured box-model tree of the page

Events are micro-batched over a single WebSocket with bounded buffering and exponential-backoff reconnection. Pending events are flushed on page hide so the last moments of a session are not lost.

Privacy by design: request headers are never collected; sensitive URL query parameters are always redacted; bodies ship only when explicitly opted in, with sensitive fields replaced by `[REDACTED]` inside the browser before anything leaves the page.

Development-only by design: it is injected by `@agentlensjs/vite-plugin` in `serve` mode and adds zero overhead to production builds.

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
