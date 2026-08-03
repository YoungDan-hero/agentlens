import { relative as posixRelative } from 'node:path/posix';

import { DEFAULT_WS_PORT, WS_PATH } from '@agentlensjs/shared';
import type { Plugin } from 'vite';

import { injectSourceAttributes } from './attribute-injector';
import { injectVueSourceAttributes } from './vue-injector';

export { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';
export { injectSourceAttributes } from './attribute-injector';
export { injectVueSourceAttributes } from './vue-injector';

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
  /**
   * Capture request/response bodies on network events (redacted and
   * truncated). Off by default: bodies may contain user data.
   * @default false
   */
  captureBodies?: boolean;
  /**
   * Project-specific sensitive key names to redact on top of the built-in
   * set (password, token, secret, ...). Case-insensitive substring match.
   * @example ['idCard', 'mobile']
   */
  redactKeys?: string[];
  /**
   * Allow the daemon's `perform_action` tool to drive the page (click,
   * type, select, scroll, same-origin navigation). Off by default: this
   * turns AgentLens from an observer into an actuator, so it must be an
   * explicit opt-in. Actions yield to real user input and every synthetic
   * interaction is recorded with a `synthetic` audit marker.
   * @default false
   */
  allowActions?: boolean;
  /**
   * Tags to treat as native custom elements in Vue SFC templates, so they
   * receive source attribution too. Mirror the `isCustomElement` you pass
   * to `@vitejs/plugin-vue` — without it, hyphenated tags classify as
   * components and are skipped.
   */
  isCustomElement?: (tag: string) => boolean;
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
  const captureBodies = options.captureBodies ?? false;
  const redactKeys = options.redactKeys ?? [];
  const allowActions = options.allowActions ?? false;
  const endpoint = `ws://localhost:${String(port)}${WS_PATH}`;
  const initOptions = JSON.stringify({ endpoint, captureBodies, redactKeys, allowActions });

  let root = process.cwd();

  return {
    name: 'agentlens',
    apply: 'serve',
    // Must transform templates (Vue SFC) and JSX before the framework
    // plugin compiles them away.
    enforce: 'pre',

    configResolved(config) {
      root = config.root;
    },

    transform(code, id) {
      if (!enabled) {
        return undefined;
      }
      // indexOf, not split with a limit: a second '?' belongs to the query,
      // split('?', 2) would silently drop everything after it.
      const queryStart = id.indexOf('?');
      const file = queryStart === -1 ? id : id.slice(0, queryStart);
      const rawQuery = queryStart === -1 ? '' : id.slice(queryStart + 1);
      if (file.includes('/node_modules/')) {
        return undefined;
      }
      const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
      // Files outside root (linked workspace packages) still get a relative
      // form: an absolute dev-machine path would break the daemon's
      // relative-path convention and leak into the page DOM.
      const fileName = file.startsWith(normalizedRoot)
        ? file.slice(normalizedRoot.length)
        : posixRelative(normalizedRoot, file);

      let result: ReturnType<typeof injectSourceAttributes> = null;
      if (file.endsWith('.vue')) {
        // Only the plain module request carries the parseable SFC.
        // Sub-requests (?vue&type=...) hold compiled fragments; asset
        // requests (?raw / ?url / ?worker) hold a JS wrapper whose string
        // literal an HTML parser would corrupt.
        const query = new URLSearchParams(rawQuery);
        const isMainSfcRequest =
          !query.has('vue') && !query.has('raw') && !query.has('url') && !query.has('worker');
        if (isMainSfcRequest) {
          result = injectVueSourceAttributes(code, fileName, options.isCustomElement);
        }
      } else if (/\.[jt]sx$/.test(file)) {
        result = injectSourceAttributes(code, fileName);
      }
      if (!result) {
        return undefined;
      }
      // Serialized map sidesteps magic-string/vite SourceMap type mismatches.
      return { code: result.code, map: result.map.toString() };
    },

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
      // A manual `import 'virtual:agentlens'` must respect enabled: false
      // too — resolve to an empty module instead of booting the runtime.
      if (!enabled) {
        return 'export {};';
      }
      return [
        // Resolved through this package's own dependency tree; see runtime.ts.
        `import { init } from '@agentlensjs/vite-plugin/runtime';`,
        `const client = init(${initOptions});`,
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
