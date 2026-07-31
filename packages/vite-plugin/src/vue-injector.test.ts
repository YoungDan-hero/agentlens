import { describe, expect, it } from 'vitest';

import { injectVueSourceAttributes } from './vue-injector';

const FILE = 'src/App.vue';

describe('injectVueSourceAttributes', () => {
  it('injects file:line into native template elements', () => {
    const sfc = [
      '<template>',
      '  <main>',
      '    <button id="go">Go</button>',
      '  </main>',
      '</template>',
    ].join('\n');

    const result = injectVueSourceAttributes(sfc, FILE);
    expect(result?.code).toContain(`<main data-agentlens-source="${FILE}:2">`);
    expect(result?.code).toContain(`<button data-agentlens-source="${FILE}:3" id="go">`);
  });

  it('reports line numbers relative to the whole SFC file', () => {
    const sfc = [
      '<script setup lang="ts">',
      'const n: number = 1;',
      '</script>',
      '',
      '<template>',
      '  <div>{{ n }}</div>',
      '</template>',
    ].join('\n');

    const result = injectVueSourceAttributes(sfc, FILE);
    expect(result?.code).toContain(`<div data-agentlens-source="${FILE}:6">`);
  });

  it('skips component tags but descends into their slot content', () => {
    const sfc = [
      '<template>',
      '  <UserCard>',
      '    <span>slot content</span>',
      '  </UserCard>',
      '</template>',
    ].join('\n');

    const result = injectVueSourceAttributes(sfc, FILE);
    expect(result?.code).toContain('<UserCard>');
    expect(result?.code).toContain(`<span data-agentlens-source="${FILE}:3">`);
  });

  it('skips template wrappers and slot outlets but tags their children', () => {
    const sfc = [
      '<template>',
      '  <template v-if="ok">',
      '    <li v-for="i in 3" :key="i">{{ i }}</li>',
      '  </template>',
      '  <slot name="footer"></slot>',
      '</template>',
    ].join('\n');

    const result = injectVueSourceAttributes(sfc, FILE);
    expect(result?.code).toContain('<template v-if="ok">');
    expect(result?.code).toContain('<slot name="footer">');
    expect(result?.code).toContain(`<li data-agentlens-source="${FILE}:3" v-for=`);
  });

  it('leaves script and style blocks untouched', () => {
    const sfc = [
      '<script setup lang="ts">',
      'const generic: Array<string> = [];',
      'console.log(generic);',
      '</script>',
      '',
      '<template>',
      '  <p>hello</p>',
      '</template>',
      '',
      '<style scoped>',
      'p { color: red; }',
      '</style>',
    ].join('\n');

    const result = injectVueSourceAttributes(sfc, FILE);
    expect(result?.code).toContain('const generic: Array<string> = [];');
    expect(result?.code).toContain('p { color: red; }');
    expect(result?.code).toContain(`<p data-agentlens-source="${FILE}:7">`);
  });

  it('respects an existing source attribute', () => {
    const sfc = '<template><div data-agentlens-source="manual:1">x</div></template>';
    expect(injectVueSourceAttributes(sfc, FILE)).toBeNull();
  });

  it('returns null for non-HTML templates and files without a template', () => {
    const pug = '<template lang="pug">\ndiv hello\n</template>';
    expect(injectVueSourceAttributes(pug, FILE)).toBeNull();

    const external = '<template src="./tpl.html"></template>';
    expect(injectVueSourceAttributes(external, FILE)).toBeNull();

    const scriptOnly = '<script setup>const a = 1;</script>';
    expect(injectVueSourceAttributes(scriptOnly, FILE)).toBeNull();
  });

  it('survives work-in-progress templates with recoverable parse errors', () => {
    // Unclosed tag: typical mid-edit state under HMR.
    const sfc = '<template>\n  <div>\n    <button id="go">Go\n</template>';
    const result = injectVueSourceAttributes(sfc, FILE);
    expect(result?.code).toContain(`<div data-agentlens-source="${FILE}:2">`);
  });

  it('generates a hires source map for the edits', () => {
    const result = injectVueSourceAttributes('<template><i>x</i></template>', FILE);
    expect(result?.map.mappings.length).toBeGreaterThan(0);
  });
});
