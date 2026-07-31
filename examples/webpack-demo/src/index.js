// Manual AgentLens integration, exactly as documented for non-Vite projects:
// dev-only dynamic import plus an optional HMR hook for verify_fix.
if (process.env.NODE_ENV === 'development') {
  void import('@agentlensjs/runtime').then(({ init }) => {
    const client = init({
      endpoint: `ws://localhost:${process.env.AGENTLENS_PORT}/agentlens`,
    });
    if (import.meta.webpackHot) {
      import.meta.webpackHot.addStatusHandler((status) => {
        if (status === 'idle') {
          client.reportHmrUpdate();
        }
      });
    }
  });
}

const heading = document.createElement('h1');
heading.textContent = 'AgentLens webpack demo';
document.body.append(heading);

// Emit one signal of each kind so the smoke test can assert the whole
// capture chain without simulating user interaction. Delayed past the
// dynamic import above: with manual integration, collectors only exist
// once the runtime chunk has loaded.
setTimeout(() => {
  console.error('console.error from webpack-demo');
  fetch('/api/does-not-exist').catch(() => undefined);
  setTimeout(() => {
    throw new Error('uncaught error from webpack-demo');
  }, 300);
}, 300);
