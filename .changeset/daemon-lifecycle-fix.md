---
'@agentlensjs/mcp-server': patch
---

Fix daemon lifecycle on MCP client reloads: the daemon now shuts down when its
stdio pipes close (Cursor stops MCP servers this way, not with signals), so it
no longer lingers as an orphan holding the ingest port. Port binding also
retries with backoff to ride out the reload handover window instead of killing
the MCP server on the first EADDRINUSE.
