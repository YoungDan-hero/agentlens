---
'@agentlensjs/runtime': patch
'@agentlensjs/mcp-server': patch
'@agentlensjs/vite-plugin': patch
'@agentlensjs/shared': patch
---

Omit incomplete or invalid JSON bodies before transmission. Stop action sequences when the user takes over and respect disabled controls and options.

Keep error records isolated per session while recognizing recurring errors across HMR and reloads. Check the final verification interval and preserve replay detection when older records are evicted.

Isolate WebSocket connection failures and reject their pending requests without stopping the daemon. Load the injected runtime under the configured Vite base path.
