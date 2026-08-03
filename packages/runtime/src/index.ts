import { DEFAULT_WS_PORT, isActionRequest, isSnapshotRequest, WS_PATH } from '@agentlensjs/shared';
import type { ActionResult, SnapshotResponse } from '@agentlensjs/shared';

import { createActionExecutor } from './actions';
import { installConsoleCollector } from './collectors/console';
import { installErrorCollector } from './collectors/errors';
import { installInteractionCollector } from './collectors/interactions';
import { installNavigationCollector } from './collectors/navigation';
import { installNetworkCollector } from './collectors/network';
import { installPerformanceCollector } from './collectors/performance';
import type { EventContext } from './events';
import { buildLifecycleEvent } from './events';
import { redactUrl, setExtraRedactKeys } from './redact';
import { captureLayoutSnapshot } from './snapshot';
import { Transport } from './transport';
import { generateId } from './uuid';

export interface InitOptions {
  /** Override the daemon WebSocket endpoint. Defaults to `ws://localhost:8631/agentlens`. */
  endpoint?: string;
  /**
   * Capture request/response bodies on network events (redacted and
   * truncated). Off by default: bodies may contain user data.
   * @default false
   */
  captureBodies?: boolean;
  /**
   * Project-specific sensitive key names to redact on top of the built-in
   * set (password, token, secret, ...). Case-insensitive substring match,
   * applied to URL query parameters and captured body fields.
   * @example ['idCard', 'mobile']
   */
  redactKeys?: string[];
  /**
   * Allow the daemon's `perform_action` tool to drive this page (click,
   * type, select, scroll, same-origin navigation). Off by default: the
   * action channel turns the daemon from an observer into an actuator, so
   * it must be an explicit opt-in. Actions refuse to run while the user is
   * actively interacting, and every synthetic interaction is captured with
   * a `synthetic` marker as an audit trail.
   * @default false
   */
  allowActions?: boolean;
}

export interface AgentLensClient {
  /**
   * Reports that a hot-module update was applied. Wired up by the Vite
   * plugin's virtual module, where `import.meta.hot` is available; the
   * daemon's `verify_fix` tool relies on this signal.
   */
  reportHmrUpdate: () => void;
  /** Tears down all collectors and closes the transport. */
  dispose: () => void;
}

declare global {
  interface Window {
    __AGENTLENS__?: AgentLensClient;
  }
}

/**
 * Boots the AgentLens runtime. Intended to be called exactly once per page,
 * typically via the virtual module injected by `@agentlensjs/vite-plugin`.
 */
export function init(options: InitOptions = {}): AgentLensClient {
  // Guard against double initialization across HMR boundaries.
  if (window.__AGENTLENS__) {
    return window.__AGENTLENS__;
  }

  // Must precede collector installation: every later redaction call
  // (URLs, bodies) consults this set.
  setExtraRedactKeys(options.redactKeys ?? []);

  const endpoint = options.endpoint ?? `ws://localhost:${String(DEFAULT_WS_PORT)}${WS_PATH}`;
  const context: EventContext = {
    sessionId: generateId(),
    // Read lazily so SPA route changes are reflected in every event's url.
    // Redacted: page URLs can carry secrets too (SSO ?code=..., hash-router
    // ...#/page?token=...).
    get url() {
      return redactUrl(window.location.href);
    },
  };

  const executor = createActionExecutor({ enabled: options.allowActions ?? false });

  const transport: Transport = new Transport({
    endpoint,
    onMessage: (message) => {
      if (isSnapshotRequest(message)) {
        const { root, truncated } = captureLayoutSnapshot();
        const response: SnapshotResponse = {
          kind: 'snapshot-response',
          requestId: message.requestId,
          sessionId: context.sessionId,
          url: context.url,
          capturedAt: Date.now(),
          root,
          truncated,
        };
        transport.sendRaw(response);
        return;
      }
      if (isActionRequest(message)) {
        void executor.handle(message).then((outcome) => {
          const result: ActionResult = {
            kind: 'action-result',
            requestId: message.requestId,
            sessionId: context.sessionId,
            ...outcome,
          };
          transport.sendRaw(result);
        });
      }
    },
  });
  // Tee: the executor watches the local event stream to know when the page
  // has settled after an action and which effects the action triggered.
  const sink = {
    send: (event: Parameters<Transport['send']>[0]): void => {
      executor.noteLocalEvent(event);
      transport.send(event);
    },
  };
  const teardowns = [
    installErrorCollector(sink, context),
    installConsoleCollector(sink, context),
    installNetworkCollector(sink, context, {
      captureBodies: options.captureBodies ?? false,
      // The transport reconnects with `new WebSocket`; the collector must
      // not observe the runtime's own daemon connection.
      ignoreWebSocketUrls: [endpoint],
    }),
    installInteractionCollector(sink, context),
    installNavigationCollector(sink, context),
    installPerformanceCollector(sink, context),
    executor.dispose,
  ];

  // Flush synchronously on pagehide: the batch window would otherwise drop
  // the last moments of a session when the tab closes or reloads.
  const onPageHide = (): void => {
    transport.send(buildLifecycleEvent(context, 'unload'));
    transport.flush();
  };
  window.addEventListener('pagehide', onPageHide);
  teardowns.push(() => {
    window.removeEventListener('pagehide', onPageHide);
  });

  transport.send(buildLifecycleEvent(context, 'load'));

  const client: AgentLensClient = {
    reportHmrUpdate: () => {
      transport.send(buildLifecycleEvent(context, 'hmr-update'));
    },
    dispose: () => {
      for (const teardown of teardowns) {
        teardown();
      }
      transport.close();
      delete window.__AGENTLENS__;
    },
  };

  window.__AGENTLENS__ = client;
  return client;
}

export type { EventContext } from './events';
