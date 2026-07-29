# @agentlens/mcp-server

The AgentLens daemon. It ingests runtime signals from `@agentlens/runtime` over WebSocket, keeps a bounded in-memory event store, and exposes them to AI coding agents via the [Model Context Protocol](https://modelcontextprotocol.io).

## Usage

Register it in your MCP client (e.g. Cursor's `mcp.json`):

```json
{
  "mcpServers": {
    "agentlens": {
      "command": "npx",
      "args": ["-y", "@agentlens/mcp-server"]
    }
  }
}
```

### Tools

| Tool                | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `get_page_health`   | Cheap overview: errors, failed requests and activity in the last 5 minutes |
| `get_recent_events` | Drill-down query over captured events with type/time/limit filters         |

### Environment variables

| Variable         | Default | Description                                                  |
| ---------------- | ------- | ------------------------------------------------------------ |
| `AGENTLENS_PORT` | `8631`  | WebSocket port the daemon listens on for runtime connections |

See the [AgentLens monorepo](https://github.com/agentlens/agentlens) for full documentation.
