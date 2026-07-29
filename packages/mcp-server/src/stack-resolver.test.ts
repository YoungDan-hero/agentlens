import { GenMapping, maybeAddMapping, toEncodedMap } from '@jridgewell/gen-mapping';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseStack, StackResolver } from './stack-resolver';

describe('parseStack', () => {
  it('parses frames with and without function names', () => {
    const stack = [
      'Error: boom',
      '    at throwIt (http://localhost:5273/src/App.tsx?t=123:55:23)',
      '    at http://localhost:5273/src/main.tsx:12:1',
    ].join('\n');

    expect(parseStack(stack)).toEqual([
      {
        functionName: 'throwIt',
        url: 'http://localhost:5273/src/App.tsx?t=123',
        line: 55,
        column: 23,
      },
      { functionName: null, url: 'http://localhost:5273/src/main.tsx', line: 12, column: 1 },
    ]);
  });

  it('ignores the message line and unparseable lines', () => {
    expect(parseStack('TypeError: x is not a function\n<anonymous>')).toEqual([]);
  });
});

/** Builds a module whose position line 1 / column 10 (1-based) maps to src/App.tsx:55:23. */
function buildModuleWithInlineMap(): string {
  const map = new GenMapping({ file: 'app.js' });
  maybeAddMapping(map, {
    generated: { line: 1, column: 9 },
    source: 'src/App.tsx',
    original: { line: 55, column: 22 },
    name: 'throwDemo',
  });
  const base64 = Buffer.from(JSON.stringify(toEncodedMap(map))).toString('base64');
  return `throw x;\n//# sourceMappingURL=data:application/json;base64,${base64}`;
}

describe('StackResolver', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps frames back to original source coordinates', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(buildModuleWithInlineMap()));
    const resolver = new StackResolver();

    const frames = await resolver.resolve(
      'Error: boom\n    at fn (http://localhost:5273/src/App.tsx?t=123:1:10)',
    );

    expect(frames).toEqual([
      { functionName: 'throwDemo', fileName: 'src/App.tsx', line: 55, column: 23 },
    ]);
  });

  it('caches the source map per module url', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(buildModuleWithInlineMap()));
    const resolver = new StackResolver();
    const stack = 'Error: x\n    at fn (http://localhost:5273/src/App.tsx?t=123:1:10)';

    await resolver.resolve(stack);
    await resolver.resolve(stack);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to cleaned raw coordinates when no map exists', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response('console.log(1);'));
    const resolver = new StackResolver();

    const frames = await resolver.resolve(
      'Error: x\n    at fn (http://localhost:5273/src/util.ts?v=abc:3:7)',
    );

    expect(frames).toEqual([{ functionName: 'fn', fileName: '/src/util.ts', line: 3, column: 7 }]);
  });

  it('never downloads from non-loopback hosts', async () => {
    const resolver = new StackResolver();

    const frames = await resolver.resolve(
      'Error: x\n    at fn (https://evil.example.com/a.js:1:1)',
    );

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(frames[0]?.fileName).toBe('/a.js');
  });

  it('survives download failures', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'));
    const resolver = new StackResolver();

    const frames = await resolver.resolve(
      'Error: x\n    at fn (http://localhost:5273/src/App.tsx:2:5)',
    );

    expect(frames).toEqual([{ functionName: 'fn', fileName: '/src/App.tsx', line: 2, column: 5 }]);
  });
});
