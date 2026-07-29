import { DEFAULT_WS_PORT, WS_PATH } from '@agentlensjs/shared';
import type { Plugin } from 'vite';

export interface AgentLensPluginOptions {
  /**
   * Port of the local AgentLens daemon.
   * @default 8631
   */
  port?: number;
  /**
   * Explicitly enable or disable injection. Defaults to dev server only.
   * @default true in `serve`, never applies in `build`
   */
  enabled?: boolean;
}

export const VIRTUAL_MODULE_ID = 'virtual:agentlens';
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

/**
 * Injects the AgentLens runtime into the page in dev mode via a virtual
 * module, so application code never needs to import it manually.
 */
export function agentlens(options: AgentLensPluginOptions = {}): Plugin {
  const enabled = options.enabled ?? true;
  const port = options.port ?? DEFAULT_WS_PORT;
  const endpoint = `ws://localhost:${String(port)}${WS_PATH}`;

  return {
    name: 'agentlens',
    apply: 'serve',

    resolveId(id) {
      if (id === VIRTUAL_MODULE_ID) {
        return RESOLVED_VIRTUAL_MODULE_ID;
      }
      return undefined;
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) {
        return undefined;
      }
      return [
        `import { init } from '@agentlensjs/runtime';`,
        `const client = init({ endpoint: ${JSON.stringify(endpoint)} });`,
        `if (import.meta.hot) {`,
        `  import.meta.hot.on('vite:afterUpdate', () => {`,
        `    client.reportHmrUpdate();`,
        `  });`,
        `}`,
      ].join('\n');
    },

    transformIndexHtml() {
      if (!enabled) {
        return undefined;
      }
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: `/@id/${VIRTUAL_MODULE_ID}` },
          injectTo: 'head' as const,
        },
      ];
    },
  };
}

export default agentlens;
