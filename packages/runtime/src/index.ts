import { DEFAULT_WS_PORT, WS_PATH } from '@agentlens/shared';

import { installErrorCollector } from './collectors/errors';
import type { EventContext } from './events';
import { buildLifecycleEvent } from './events';
import { Transport } from './transport';

export interface InitOptions {
  /** Override the daemon WebSocket endpoint. Defaults to `ws://localhost:8631/agentlens`. */
  endpoint?: string;
}

export interface AgentLensClient {
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
 * typically via the virtual module injected by `@agentlens/vite-plugin`.
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

  const transport = new Transport({ endpoint });
  const teardowns = [installErrorCollector(transport, context)];

  transport.send(buildLifecycleEvent(context, 'load'));

  const client: AgentLensClient = {
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
