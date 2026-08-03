import type { SourceElementSummary } from '@agentlensjs/shared';
import { SOURCE_ATTRIBUTE } from '@agentlensjs/shared';

import { isElementVisible } from './visibility';

/** Caps the response size: a hot file can render hundreds of list items. */
const MAX_ELEMENTS = 100;
const MAX_TEXT_LENGTH = 120;

/**
 * Finds the elements currently rendered by a source file — the reverse
 * direction of source attribution. Accepts either a plain file path
 * (`src/App.vue`, matches every line of that file) or an exact attribution
 * value (`src/App.vue:42`).
 */
export function findElementsBySource(source: string): {
  elements: SourceElementSummary[];
  truncated: boolean;
} {
  const tagged = [...document.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)];
  const matches = tagged.filter((element) => {
    const value = element.getAttribute(SOURCE_ATTRIBUTE);
    // `src/App.vue` must match `src/App.vue:42` but not `src/App.vue.bak:7`,
    // hence the explicit `:` boundary instead of a plain prefix test.
    return value !== null && (value === source || value.startsWith(`${source}:`));
  });

  const truncated = matches.length > MAX_ELEMENTS;
  const elements = matches.slice(0, MAX_ELEMENTS).map((element): SourceElementSummary => {
    const text = element.textContent.trim().slice(0, MAX_TEXT_LENGTH);
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id === '' ? null : element.id,
      text: text === '' ? null : text,
      visible: isElementVisible(element),
      source: element.getAttribute(SOURCE_ATTRIBUTE) ?? '',
    };
  });
  return { elements, truncated };
}
