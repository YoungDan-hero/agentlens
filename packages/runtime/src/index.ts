import { DEFAULT_WS_PORT, isSnapshotRequest, WS_PATH } from '@agentlensjs/shared';
import type { SnapshotResponse } from '@agentlensjs/shared';

import { installConsoleCollector } from './collectors/console';
import { installErrorCollector } from './collectors/errors';
import { installInteractionCollector } from './collectors/interactions';
import { installNetworkCollector } from './collectors/network';
import type { EventContext } from './events';
import { buildLifecycleEvent } from './events';
import { captureLayoutSnapshot } from './snapshot';
import { Transport } from './transport';

export interface InitOptions {
  /** Override the daemon WebSocket endpoint. Defaults to `ws://localhost:8631/agentlens`. */
  endpoint?: string;
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

  const endpoint = options.endpoint ?? `ws://localhost:${String(DEFAULT_WS_PORT)}${WS_PATH}`;
  const context: EventContext = {
    sessionId: crypto.randomUUID(),
    url: window.location.href,
  };

  const transport: Transport = new Transport({
    endpoint,
    onMessage: (message) => {
      if (!isSnapshotRequest(message)) {
        return;
      }
      const { root, truncated } = captureLayoutSnapshot();
      const response: SnapshotResponse = {
        kind: 'snapshot-response',
        requestId: message.requestId,
        sessionId: context.sessionId,
        url: window.location.href,
        capturedAt: Date.now(),
        root,
        truncated,
      };
      transport.sendRaw(response);
    },
  });
  const teardowns = [
    installErrorCollector(transport, context),
    installConsoleCollector(transport, context),
    installNetworkCollector(transport, context),
    installInteractionCollector(transport, context),
  ];

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
