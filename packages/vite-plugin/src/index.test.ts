import { describe, expect, it } from 'vitest';

import type { HtmlTagDescriptor } from 'vite';
import { agentlens, VIRTUAL_MODULE_ID } from './index';

function callHook(hook: unknown, ...args: unknown[]): unknown {
  const fn = typeof hook === 'function' ? hook : (hook as { handler: unknown }).handler;
  return (fn as (...a: unknown[]) => unknown).apply({}, args);
}

describe('agentlens vite plugin', () => {
  it('only applies to the dev server', () => {
    const plugin = agentlens();
    expect(plugin.name).toBe('agentlens');
    expect(plugin.apply).toBe('serve');
  });

  it('resolves and loads the virtual module with the configured endpoint', () => {
    const plugin = agentlens({ port: 9999 });

    const resolved = callHook(plugin.resolveId, VIRTUAL_MODULE_ID) as string;
    expect(resolved).toBe(`\0${VIRTUAL_MODULE_ID}`);

    const code = callHook(plugin.load, resolved) as string;
    // Must import through the plugin's own real-file entry, not a bare
    // runtime specifier the user's project cannot resolve.
    expect(code).toContain(`@agentlensjs/vite-plugin/runtime`);
    expect(code).toContain('ws://localhost:9999/agentlens');
    // Body capture stays opt-out unless the user enables it explicitly.
    expect(code).toContain('"captureBodies":false');
    // HMR updates must be reported so the daemon's verify_fix can work.
    expect(code).toContain('vite:afterUpdate');
    expect(code).toContain('reportHmrUpdate');
  });

  it('forwards captureBodies to the runtime init call', () => {
    const plugin = agentlens({ captureBodies: true });
    const resolved = callHook(plugin.resolveId, VIRTUAL_MODULE_ID) as string;
    const code = callHook(plugin.load, resolved) as string;
    expect(code).toContain('"captureBodies":true');
  });

  it('forwards redactKeys to the runtime init call', () => {
    const plugin = agentlens({ redactKeys: ['idCard', 'mobile'] });
    const resolved = callHook(plugin.resolveId, VIRTUAL_MODULE_ID) as string;
    const code = callHook(plugin.load, resolved) as string;
    expect(code).toContain('"redactKeys":["idCard","mobile"]');
  });

  it('injects a module script tag into the html head', () => {
    const plugin = agentlens();
    const tags = callHook(plugin.transformIndexHtml) as HtmlTagDescriptor[];

    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe('script');
    expect(tags[0]?.attrs?.src).toBe(`/@id/${VIRTUAL_MODULE_ID}`);
    expect(tags[0]?.injectTo).toBe('head');
  });

  it('injects nothing when disabled', () => {
    const plugin = agentlens({ enabled: false });
    const tags = callHook(plugin.transformIndexHtml) as HtmlTagDescriptor[] | undefined;
    expect(tags).toBeUndefined();
  });

  it('runs before framework plugins so it sees raw JSX', () => {
    expect(agentlens().enforce).toBe('pre');
  });

  it('injects source attributes into jsx modules relative to the vite root', () => {
    const plugin = agentlens();
    callHook(plugin.configResolved, { root: '/repo/app' });

    const result = callHook(
      plugin.transform,
      'export const A = () => <div />;',
      '/repo/app/src/A.tsx',
    ) as { code: string } | undefined;
    expect(result?.code).toContain('data-agentlens-source="src/A.tsx:1"');
  });

  it('ignores non-jsx files, node_modules and disabled mode', () => {
    const plugin = agentlens();
    callHook(plugin.configResolved, { root: '/repo/app' });
    const jsx = 'export const A = () => <div />;';

    expect(callHook(plugin.transform, 'const n = 1;', '/repo/app/src/n.ts')).toBeUndefined();
    expect(callHook(plugin.transform, jsx, '/repo/app/node_modules/lib/x.tsx')).toBeUndefined();

    const disabled = agentlens({ enabled: false });
    callHook(disabled.configResolved, { root: '/repo/app' });
    expect(callHook(disabled.transform, jsx, '/repo/app/src/A.tsx')).toBeUndefined();
  });
});
