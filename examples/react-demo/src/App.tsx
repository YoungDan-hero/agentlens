import type { CSSProperties, JSX } from 'react';
import { useState } from 'react';

const pageStyle: CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  maxWidth: 640,
  margin: '4rem auto',
  padding: '0 1rem',
  lineHeight: 1.6,
};

const buttonStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  margin: '0.5rem 0',
  padding: '0.75rem 1rem',
  fontSize: '1rem',
  borderRadius: 8,
  border: '1px solid #d0d0d0',
  background: '#fafafa',
  cursor: 'pointer',
  textAlign: 'left',
};

const logStyle: CSSProperties = {
  marginTop: '1.5rem',
  padding: '0.75rem 1rem',
  borderRadius: 8,
  background: '#f4f4f5',
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.85rem',
  whiteSpace: 'pre-wrap',
};

async function fetchUnreachableHost(): Promise<void> {
  try {
    // Port 9 (discard) is on every browser's blocked-port list, so the fetch
    // fails at the transport level instantly — no DNS lookup, no timeout.
    await fetch('http://127.0.0.1:9/unreachable');
  } catch {
    // Expected: transport-level failure is what we want AgentLens to capture.
  }
}

export function App(): JSX.Element {
  const [log, setLog] = useState<string[]>([]);

  const record = (message: string): void => {
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date());
    setLog((entries) => [`[${time}] ${message}`, ...entries].slice(0, 8));
  };

  const throwUncaughtError = (): void => {
    record('emitted: uncaught error (see DevTools console / AgentLens)');
    throw new Error('Demo: uncaught error from button click');
  };

  const rejectPromise = (): void => {
    record('emitted: unhandled promise rejection');
    void Promise.reject(new Error('Demo: unhandled promise rejection'));
  };

  const logConsoleError = (): void => {
    record('emitted: console.error with payload');
    console.error('Demo: console.error with payload', { userId: 42, reason: 'invalid state' });
  };

  const fetchMissingEndpoint = (): void => {
    record('emitted: GET /api/does-not-exist (404)');
    void fetch('/api/does-not-exist');
  };

  const fetchUnreachable = (): void => {
    record('emitted: GET http://127.0.0.1:9/unreachable (transport failure)');
    void fetchUnreachableHost();
  };

  return (
    <main style={pageStyle}>
      <h1>AgentLens Demo</h1>
      <p>
        Each button emits a runtime signal. The page itself stays quiet by design — the signals
        surface in DevTools and in the AgentLens daemon. Ask your AI agent{' '}
        <em>&ldquo;does the page have any errors right now?&rdquo;</em> and it will answer via the
        AgentLens MCP server.
      </p>

      <button id="btn-error" style={buttonStyle} onClick={throwUncaughtError}>
        1. Throw an uncaught error
      </button>
      <button id="btn-rejection" style={buttonStyle} onClick={rejectPromise}>
        2. Trigger an unhandled promise rejection
      </button>
      <button id="btn-console" style={buttonStyle} onClick={logConsoleError}>
        3. Log a console.error
      </button>
      <button id="btn-404" style={buttonStyle} onClick={fetchMissingEndpoint}>
        4. Fetch a 404 endpoint
      </button>
      <button id="btn-network-fail" style={buttonStyle} onClick={fetchUnreachable}>
        5. Fetch an unreachable host
      </button>

      <section id="signal-log" style={logStyle} aria-live="polite">
        {log.length === 0 ? 'No signals emitted yet — click a button above.' : log.join('\n')}
      </section>
    </main>
  );
}
