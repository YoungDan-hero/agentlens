// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureLayoutSnapshot } from './snapshot';

function stubRects(width: number, height: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 20,
    width,
    height,
    top: 20,
    left: 10,
    right: 10 + width,
    bottom: 20 + height,
    toJSON: () => ({}),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('captureLayoutSnapshot', () => {
  it('captures tags, rects, source attribution and direct text', () => {
    stubRects(120, 40);
    document.body.innerHTML =
      '<main data-agentlens-source="src/App.tsx:3">' +
      '<button data-agentlens-source="src/App.tsx:7">Click me</button>' +
      '</main>';

    const { root, truncated } = captureLayoutSnapshot(document);

    expect(truncated).toBe(false);
    expect(root?.tag).toBe('body');
    const main = root?.children[0];
    expect(main?.tag).toBe('main');
    expect(main?.source).toBe('src/App.tsx:3');
    const button = main?.children[0];
    expect(button?.tag).toBe('button');
    expect(button?.source).toBe('src/App.tsx:7');
    expect(button?.text).toBe('Click me');
    expect(button?.rect).toEqual({ x: 10, y: 20, width: 120, height: 40 });
    expect(button?.visible).toBe(true);
  });

  it('marks hidden and zero-sized elements as not visible', () => {
    stubRects(100, 30);
    document.body.innerHTML = '<div style="display: none">ghost</div><span>ok</span>';

    const { root } = captureLayoutSnapshot(document);
    const [hidden, shown] = root?.children ?? [];
    expect(hidden?.visible).toBe(false);
    expect(shown?.visible).toBe(true);
  });

  it('skips non-layout elements entirely', () => {
    stubRects(100, 30);
    document.body.innerHTML = '<script>1</script><style>a{}</style><p>content</p>';

    const { root } = captureLayoutSnapshot(document);
    expect(root?.children.map((c) => c.tag)).toEqual(['p']);
  });

  it('truncates long direct text and ignores nested text', () => {
    stubRects(100, 30);
    document.body.innerHTML = `<div>${'x'.repeat(80)}<em>nested</em></div>`;

    const { root } = captureLayoutSnapshot(document);
    const div = root?.children[0];
    expect(div?.text).toBe(`${'x'.repeat(60)}…`);
    expect(div?.children[0]?.text).toBe('nested');
  });

  it('stops at the node budget and flags truncation', () => {
    stubRects(100, 30);
    document.body.innerHTML = Array.from({ length: 10 }, () => '<div></div>').join('');

    // Budget of 4: body + 3 divs.
    const { root, truncated } = captureLayoutSnapshot(document, 4);
    expect(truncated).toBe(true);
    expect(root?.children).toHaveLength(3);
  });

  it('returns a null root when the document has no body', () => {
    const bare = document.implementation.createDocument(null, null, null);
    const { root } = captureLayoutSnapshot(bare);
    expect(root).toBeNull();
  });
});

describe('captureLayoutSnapshot — SVG', () => {
  it('skips script and style elements inside SVG despite lowercase tagNames', () => {
    stubRects(50, 50);
    document.body.innerHTML =
      '<svg><style>.a{fill:red}</style><script>1</script><rect class="a"></rect></svg>';

    const { root } = captureLayoutSnapshot(document);

    const svg = root?.children[0];
    expect(svg?.tag).toBe('svg');
    // Only the rect survives: SVG tagNames stay lowercase, but script and
    // style are just as layout-irrelevant there as in HTML.
    expect(svg?.children.map((child) => child.tag)).toEqual(['rect']);
  });
});
