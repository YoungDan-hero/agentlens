import type { LayoutNode } from '@agentlensjs/shared';
import { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';

/** Elements that never contribute to visible layout. */
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);

const MAX_TEXT_LENGTH = 60;
const DEFAULT_MAX_NODES = 800;

export interface SnapshotResult {
  root: LayoutNode | null;
  truncated: boolean;
}

function directText(element: Element): string | null {
  let text = '';
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
    }
  }
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH)}…` : trimmed;
}

/**
 * Captures a compact box-model tree of the current page. Each node carries
 * its viewport rect, visibility, overflow state and the source attribution
 * injected by the Vite plugin — enough for an agent to reason about layout
 * without a screenshot, and to know which source line renders each box.
 *
 * The tree is bounded by a node budget; when exhausted, remaining subtrees
 * are dropped and the result is flagged as truncated.
 */
export function captureLayoutSnapshot(
  doc: Document = document,
  maxNodes: number = DEFAULT_MAX_NODES,
): SnapshotResult {
  const body = doc.body as HTMLElement | null;
  if (!body) {
    return { root: null, truncated: false };
  }

  let budget = maxNodes;
  let truncated = false;
  const view = doc.defaultView;

  function visit(element: Element): LayoutNode | null {
    // toUpperCase: SVG tagNames stay lowercase ('script' inside an <svg>),
    // and those scripts/styles are just as layout-irrelevant as HTML ones.
    if (SKIPPED_TAGS.has(element.tagName.toUpperCase())) {
      return null;
    }
    if (budget <= 0) {
      truncated = true;
      return null;
    }
    budget -= 1;

    const rect = element.getBoundingClientRect();
    const style = view?.getComputedStyle(element);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style?.display !== 'none' &&
      style?.visibility !== 'hidden';
    const overflow =
      element.scrollWidth > element.clientWidth + 1 ||
      element.scrollHeight > element.clientHeight + 1;

    const children: LayoutNode[] = [];
    for (const child of element.children) {
      const node = visit(child);
      if (node) {
        children.push(node);
      }
    }

    return {
      tag: element.tagName.toLowerCase(),
      source: element.getAttribute(SOURCE_ATTRIBUTE),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      visible,
      overflow,
      text: directText(element),
      children,
    };
  }

  return { root: visit(body), truncated };
}
