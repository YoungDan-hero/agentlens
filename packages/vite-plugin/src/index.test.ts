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
    expect(code).toContain(`@agentlens/runtime`);
    expect(code).toContain('ws://localhost:9999/agentlens');
    // HMR updates must be reported so the daemon's verify_fix can work.
    expect(code).toContain('vite:afterUpdate');
    expect(code).toContain('reportHmrUpdate');
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
});
