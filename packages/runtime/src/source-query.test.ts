// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { findElementsBySource } from './source-query';

describe('findElementsBySource', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches a plain file path against every attributed line of that file', () => {
    document.body.innerHTML = `
      <button id="save" data-agentlens-source="src/App.vue:12">Save</button>
      <p data-agentlens-source="src/App.vue:20">Hello</p>
      <div data-agentlens-source="src/Other.vue:3">other</div>
      <span data-agentlens-source="src/App.vue.bak:7">decoy</span>
    `;

    const { elements, truncated } = findElementsBySource('src/App.vue');

    expect(truncated).toBe(false);
    expect(elements).toEqual([
      { tag: 'button', id: 'save', text: 'Save', visible: true, source: 'src/App.vue:12' },
      { tag: 'p', id: null, text: 'Hello', visible: true, source: 'src/App.vue:20' },
    ]);
  });

  it('matches an exact file:line attribution', () => {
    document.body.innerHTML = `
      <button data-agentlens-source="src/App.vue:12">A</button>
      <button data-agentlens-source="src/App.vue:120">B</button>
    `;

    const { elements } = findElementsBySource('src/App.vue:12');

    expect(elements).toHaveLength(1);
    expect(elements[0]?.text).toBe('A');
  });

  it('reports hidden elements as not visible', () => {
    document.body.innerHTML = `
      <div data-agentlens-source="src/App.vue:1" style="display: none">gone</div>
    `;

    const { elements } = findElementsBySource('src/App.vue');

    expect(elements[0]?.visible).toBe(false);
  });

  it('reports elements inside a display:none ancestor as not visible', () => {
    // display does not inherit: the child's own computed style stays
    // "block", so naive per-element style checks would miss this.
    document.body.innerHTML = `
      <div style="display: none">
        <button data-agentlens-source="src/App.vue:5">inside collapsed panel</button>
      </div>
    `;

    const { elements } = findElementsBySource('src/App.vue');

    expect(elements).toHaveLength(1);
    expect(elements[0]?.visible).toBe(false);
  });

  it('caps the response and flags truncation', () => {
    document.body.innerHTML = Array.from(
      { length: 150 },
      (_, i) => `<li data-agentlens-source="src/List.vue:${String(i + 1)}">item</li>`,
    ).join('');

    const { elements, truncated } = findElementsBySource('src/List.vue');

    expect(elements).toHaveLength(100);
    expect(truncated).toBe(true);
  });

  it('returns an empty result for files that render nothing', () => {
    const { elements, truncated } = findElementsBySource('src/Nowhere.vue');
    expect(elements).toEqual([]);
    expect(truncated).toBe(false);
  });
});
