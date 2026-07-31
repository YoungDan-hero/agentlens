import { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';
import type { AttributeNode, ElementNode, RootNode, TemplateChildNode } from '@vue/compiler-dom';
import { ElementTypes, NodeTypes, parse } from '@vue/compiler-dom';
// Named import on purpose — see attribute-injector.ts.
import { MagicString } from 'magic-string';

import type { InjectResult } from './attribute-injector';

/**
 * Tags that appear in templates but never render as DOM elements themselves:
 * `<template>` wrappers (v-if / v-for grouping) and `<slot>` outlets. Their
 * children still render, so the walk descends into them.
 */
const NON_RENDERED_TAGS = new Set(['template', 'slot']);

function findAttribute(node: ElementNode, name: string): AttributeNode | undefined {
  return node.props.find(
    (prop): prop is AttributeNode => prop.type === NodeTypes.ATTRIBUTE && prop.name === name,
  );
}

/**
 * Adds `data-agentlens-source="<file>:<line>"` to every native element in a
 * Vue SFC's template block, mirroring what the Babel injector does for JSX
 * host elements. Component tags are left untouched — an attribute there
 * would become a component prop instead of landing on a DOM node (Vue's
 * attribute fallthrough is not guaranteed for multi-root components).
 *
 * The whole SFC is parsed with `@vue/compiler-dom` (script/style blocks are
 * raw text to the HTML parser), so reported line numbers are relative to the
 * `.vue` file itself — exactly what an agent needs to open the right line.
 *
 * Returns `null` when there is nothing to inject or the file cannot be
 * walked (e.g. a `lang="pug"` template); the caller then leaves the code
 * as-is. This must never break the dev server.
 */
export function injectVueSourceAttributes(code: string, fileName: string): InjectResult | null {
  let root: RootNode;
  try {
    root = parse(code, {
      // Recoverable template errors (work-in-progress code under HMR) must
      // not break the transform; the parser still yields a usable tree.
      onError: () => undefined,
    });
  } catch {
    return null;
  }

  const source = new MagicString(code);

  const visit = (node: TemplateChildNode): void => {
    if (node.type !== NodeTypes.ELEMENT) {
      return;
    }
    if (
      node.tagType === ElementTypes.ELEMENT &&
      !NON_RENDERED_TAGS.has(node.tag) &&
      !findAttribute(node, SOURCE_ATTRIBUTE)
    ) {
      const location = `${fileName}:${String(node.loc.start.line)}`;
      source.appendLeft(
        node.loc.start.offset + node.tag.length + 1,
        ` ${SOURCE_ATTRIBUTE}=${JSON.stringify(location)}`,
      );
    }
    // Descend regardless of tag type: slot content inside a component tag
    // renders as real DOM and deserves attribution too.
    for (const child of node.children) {
      visit(child);
    }
  };

  for (const block of root.children) {
    if (block.type !== NodeTypes.ELEMENT || block.tag !== 'template') {
      continue;
    }
    // Non-HTML template sources cannot be offset-patched as text.
    const lang = findAttribute(block, 'lang');
    if (lang?.value && lang.value.content !== 'html') {
      continue;
    }
    if (findAttribute(block, 'src')) {
      continue;
    }
    for (const child of block.children) {
      visit(child);
    }
  }

  if (!source.hasChanged()) {
    return null;
  }
  return {
    code: source.toString(),
    map: source.generateMap({ hires: true }),
  };
}
