import { agentlens } from '@agentlensjs/vite-plugin';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

/**
 * Vite's SPA fallback answers unknown paths with index.html (200),
 * so a real 404 endpoint is needed to demo failed-request capture.
 */
function fakeApi(): Plugin {
  return {
    name: 'demo-fake-api',
    configureServer(server) {
      server.middlewares.use('/api', (_req, res) => {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
      });
    },
  };
}

// Lets the E2E pipeline point the runtime at an isolated daemon instance
// without disturbing a developer's default setup.
const daemonPort = process.env.AGENTLENS_PORT ? Number(process.env.AGENTLENS_PORT) : undefined;

export default defineConfig({
  plugins: [react(), agentlens(daemonPort === undefined ? {} : { port: daemonPort }), fakeApi()],
});
