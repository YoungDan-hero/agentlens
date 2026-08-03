# @agentlensjs/mcp-server

The AgentLens daemon. It ingests runtime signals from `@agentlensjs/runtime` over WebSocket, keeps a bounded in-memory event store, and exposes them to AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io).

## Usage

Register it in your MCP client (e.g. Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "agentlens": {
      "command": "npx",
      "args": ["-y", "@agentlensjs/mcp-server"]
    }
  }
}
```

### Tools

| Tool                       | Purpose                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `get_page_health`          | Overview scoped to the most recent session: distinct errors (with folded occurrence counts), failed requests, activity |
| `get_error_context`        | One-call root-cause bundle: the folded error, preceding interactions, related network/console signals, session vitals  |
| `get_recent_events`        | Drill-down query over captured events with type/session/time/limit/source-file filters                                 |
| `list_sessions`            | Known page sessions, most recently active first, with live focus state (`connected`, `visible`, `focused`)             |
| `verify_fix`               | Closes the loop after a code edit: waits for HMR/reload, then reports whether the error fingerprint recurred           |
| `get_layout_snapshot`      | Live structured layout tree of the page: boxes, visibility, overflow, text and per-element source attribution          |
| `find_elements_by_source`  | Reverse source lookup: the elements a source file (`src/App.vue` or `src/App.vue:42`) renders on the live page         |
| `get_interaction_timeline` | Cause-and-effect view: user interactions grouped with the errors, requests and logs they triggered                     |
| `get_performance`          | Current Web Vitals (FCP, LCP, CLS, INP, TTFB with web.dev ratings) and long-task pressure for a session                |
| `perform_action`           | Drives the live page — click, type, select, scroll, same-origin navigate — when the app opts in with `allowActions`    |
| `perform_actions`          | Runs up to 20 actions in one round-trip, each with an optional local `waitFor` condition; reports the break point      |
| `replay_error_path`        | Derives a reproduction script from the interactions before an error, executes it and reports `errorRecurred`           |
| `wait_for_idle`            | Blocks until the session's event stream has been quiet for a configurable window (or a timeout elapses)                |

### Fix verification workflow

Every captured error carries a daemon-assigned `fingerprint`. After editing code, an agent calls `verify_fix` with that fingerprint; the tool waits for the new code to reach the browser (hot module update or full reload, reported by the runtime), then observes a quiet window for recurrence. Interaction-triggered errors still need the interaction to be re-triggered for full certainty — the result says so explicitly.

### Browser action channel

`perform_action` sends an action request down the same WebSocket the runtime uses for ingest; the runtime executes it with synthetic DOM events (React and Vue v-model compatible), waits for the page to settle, and reports the element it acted on plus the errors, failed requests and console errors the action triggered. The channel is off unless the app sets `allowActions: true`; actions are refused while the user is actively interacting, run one at a time, never navigate cross-origin, and every synthetic interaction is stored with a `synthetic: true` audit marker.

`perform_actions` batches up to 20 steps into one round-trip. Each step may declare a `waitFor` condition (locator + `visible` / `attached` / `hidden` + timeout) that the runtime polls locally, so async UI needs no agent round-trip. The sequence stops at the first failure — or immediately when the user starts interacting — and reports `stoppedAt`, `stopReason`, per-step outcomes, accumulated effects and the final URL. `navigate` is only allowed as the final step.

`replay_error_path` turns the human interactions that preceded an error (synthetic ones are filtered out) into such a sequence: clicks locate via source attribution, inputs are flagged `needsValue` because typed values are never captured. It dry-runs by default; executing compares the error fingerprint's occurrence count before and after and answers `errorRecurred` — the one-command fix verification.

### Focus-aware session picking

The runtime reports page visibility and focus on every (re)connect and on each change. When several pages are connected, snapshots and actions target the focused page — the one the user is actually looking at — falling back to visible, then most-recently-active sessions. `list_sessions` exposes the same state per session.

### Ingest security

The ingest endpoint binds to `127.0.0.1` and additionally rejects WebSocket handshakes whose `Origin` is not a local dev origin (loopback, `*.localhost`, RFC 1918 hosts) — a malicious website open in the same browser cannot connect and inject forged events into an agent's context. Every accepted event is schema-validated field-by-field before it reaches the store; malformed payloads and mismatched protocol versions are dropped with a diagnostic on stderr.

### Environment variables

| Variable                    | Default | Description                                                    |
| --------------------------- | ------- | -------------------------------------------------------------- |
| `AGENTLENS_PORT`            | `8631`  | WebSocket port the daemon listens on for runtime connections   |
| `AGENTLENS_ALLOWED_ORIGINS` | —       | Comma-separated extra origins allowed to connect (exact match) |

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
