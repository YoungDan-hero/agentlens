import { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';
import { parse } from '@babel/parser';
import MagicString from 'magic-string';

export interface InjectResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
}

interface BabelNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
}

function isNode(value: unknown): value is BabelNode {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/** Depth-first walk over every AST node without pulling in @babel/traverse. */
function walk(node: BabelNode, visit: (node: BabelNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) {
          walk(item, visit);
        }
      }
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

interface JsxAttributeLike extends BabelNode {
  name?: BabelNode & { name?: unknown };
}

function hasSourceAttribute(attributes: unknown): boolean {
  if (!Array.isArray(attributes)) {
    return false;
  }
  return attributes.some((attribute: unknown) => {
    if (!isNode(attribute) || attribute.type !== 'JSXAttribute') {
      return false;
    }
    const name = (attribute as JsxAttributeLike).name;
    return name?.type === 'JSXIdentifier' && name.name === SOURCE_ATTRIBUTE;
  });
}

/**
 * Adds `data-agentlens-source="<file>:<line>"` to every host element
 * (lowercase JSX tag) in the module, so DOM nodes can be traced back to the
 * exact source location that rendered them. Component tags (uppercase),
 * member expressions and fragments are left untouched — injecting there
 * would pollute component props instead of landing on a DOM node.
 *
 * Returns `null` when the module has nothing to inject or cannot be parsed;
 * the caller should then leave the code as-is.
 */
export function injectSourceAttributes(code: string, fileName: string): InjectResult | null {
  let ast: BabelNode;
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true,
    }) as unknown as BabelNode;
  } catch {
    // Never break the dev server over a file we cannot parse.
    return null;
  }

  const source = new MagicString(code);

  walk(ast, (node) => {
    if (node.type !== 'JSXOpeningElement') {
      return;
    }
    const name = node.name;
    if (!isNode(name) || name.type !== 'JSXIdentifier') {
      return;
    }
    const tag = (name as { name?: unknown }).name;
    if (typeof tag !== 'string' || !/^[a-z]/.test(tag)) {
      return;
    }
    if (hasSourceAttribute(node.attributes)) {
      return;
    }
    if (typeof name.end !== 'number' || !node.loc) {
      return;
    }
    const location = `${fileName}:${String(node.loc.start.line)}`;
    source.appendLeft(name.end, ` ${SOURCE_ATTRIBUTE}=${JSON.stringify(location)}`);
  });

  if (!source.hasChanged()) {
    return null;
  }
  return {
    code: source.toString(),
    map: source.generateMap({ hires: true }),
  };
}
