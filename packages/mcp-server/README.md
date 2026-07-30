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
| `get_recent_events`        | Drill-down query over captured events with type/session/time/limit filters                                             |
| `list_sessions`            | Known page sessions (one per page load / tab), most recently active first                                              |
| `verify_fix`               | Closes the loop after a code edit: waits for HMR/reload, then reports whether the error fingerprint recurred           |
| `get_layout_snapshot`      | Live structured layout tree of the page: boxes, visibility, overflow, text and per-element source attribution          |
| `get_interaction_timeline` | Cause-and-effect view: user interactions grouped with the errors, requests and logs they triggered                     |
| `get_performance`          | Current Web Vitals (FCP, LCP, CLS, INP, TTFB with web.dev ratings) and long-task pressure for a session                |

### Fix verification workflow

Every captured error carries a daemon-assigned `fingerprint`. After editing code, an agent calls `verify_fix` with that fingerprint; the tool waits for the new code to reach the browser (hot module update or full reload, reported by the runtime), then observes a quiet window for recurrence. Interaction-triggered errors still need the interaction to be re-triggered for full certainty — the result says so explicitly.

### Environment variables

| Variable         | Default | Description                                                  |
| ---------------- | ------- | ------------------------------------------------------------ |
| `AGENTLENS_PORT` | `8631`  | WebSocket port the daemon listens on for runtime connections |

See the [AgentLens monorepo](https://github.com/YoungDan-hero/agentlens) for full documentation.
