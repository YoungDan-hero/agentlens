# @agentlensjs/runtime

In-browser collector SDK for AgentLens. Captures runtime signals during development and streams them to the local AgentLens daemon over WebSocket:

- **Errors** — uncaught exceptions and unhandled promise rejections
- **Console** — all five levels, with bounded, safely serialized arguments
- **Network** — `fetch`, `XMLHttpRequest` (axios included), WebSocket connections and `sendBeacon` calls with status, duration and the initiator stack for caller attribution; request/response bodies optionally captured (opt-in via `captureBodies`, redacted and size-capped)
- **Performance** — Web Vitals (FCP, LCP, CLS, INP, TTFB with web.dev ratings) and long tasks via the native `PerformanceObserver`
- **Interactions** — clicks, debounced inputs and form submits, attributed to the source line that rendered the element
- **Lifecycle** — page load, SPA route changes (History API), HMR updates and unload
- **Layout snapshots** — answers daemon requests with a structured box-model tree of the page
- **Action channel (opt-in)** — executes daemon-requested page actions (click, type, select, scroll, same-origin navigate) with synthetic DOM events compatible with React state tracking and Vue v-model; refuses to act while the user is interacting, and marks every synthetic interaction with `synthetic: true` for auditability

Events are micro-batched over a single WebSocket with bounded buffering and exponential-backoff reconnection. Pending events are flushed on page hide so the last moments of a session are not lost.

Privacy by design: request headers are never collected; sensitive URL query parameters are always redacted; bodies ship only when explicitly opted in, with sensitive fields replaced by `[REDACTED]` inside the browser before anything leaves the page. Project-specific key names (e.g. `idCard`, `mobile`) can be added via `init({ redactKeys })`.

Development-only by design: it is injected by `@agentlensjs/vite-plugin` in `serve` mode and adds zero overhead to production builds.

## Standalone usage (non-Vite projects)

On Webpack, Next.js or any other toolchain, initialize the SDK manually in your client entry:

```ts
// client entry — dev only; the dynamic import keeps production bundles clean
if (process.env.NODE_ENV === 'development') {
  void import('@agentlensjs/runtime').then(({ init }) => {
    init({
      // endpoint: 'ws://localhost:8631/agentlens', // match AGENTLENS_PORT if changed
      // captureBodies: false, // opt in to request/response bodies (redacted)
      // redactKeys: ['idCard'], // project-specific sensitive keys
      // allowActions: false, // opt in to agent-driven page actions (perform_action)
    });
  });
}
```

Note that collectors only exist once the dynamically imported chunk has loaded: signals fired synchronously during application startup (before that tick) are not captured.

All signals and MCP tools work in this mode. Two degradations compared to the Vite plugin: no `file:line` source attribution (elements are described by tag / id / class), and `verify_fix` relies on full page reloads unless you wire your bundler's HMR API to the returned client's `reportHmrUpdate()`.

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
