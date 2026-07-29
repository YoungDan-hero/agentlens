import { describe, expect, it } from 'vitest';

import { injectSourceAttributes, SOURCE_ATTRIBUTE } from './attribute-injector';

describe('injectSourceAttributes', () => {
  it('tags host elements with file and line', () => {
    const code = ['export function App() {', '  return <div>hello</div>;', '}'].join('\n');

    const result = injectSourceAttributes(code, 'src/App.tsx');
    expect(result).not.toBeNull();
    expect(result?.code).toContain(`<div ${SOURCE_ATTRIBUTE}="src/App.tsx:2">`);
    expect(result?.map).toBeTruthy();
  });

  it('tags self-closing elements and preserves existing attributes', () => {
    const code = `export const A = () => <input id="name" disabled />;`;

    const result = injectSourceAttributes(code, 'src/A.tsx');
    expect(result?.code).toContain(
      `<input ${SOURCE_ATTRIBUTE}="src/A.tsx:1" id="name" disabled />`,
    );
  });

  it('tags nested host elements each with their own line', () => {
    const code = [
      'export function App() {',
      '  return (',
      '    <main>',
      '      <button>go</button>',
      '    </main>',
      '  );',
      '}',
    ].join('\n');

    const result = injectSourceAttributes(code, 'src/App.tsx');
    expect(result?.code).toContain(`<main ${SOURCE_ATTRIBUTE}="src/App.tsx:3">`);
    expect(result?.code).toContain(`<button ${SOURCE_ATTRIBUTE}="src/App.tsx:4">`);
  });

  it('skips component tags, member expressions and fragments', () => {
    const code = [
      'export function App() {',
      '  return (',
      '    <>',
      '      <Widget prop={1} />',
      '      <Nested.Panel />',
      '    </>',
      '  );',
      '}',
    ].join('\n');

    expect(injectSourceAttributes(code, 'src/App.tsx')).toBeNull();
  });

  it('does not duplicate a manually written source attribute', () => {
    const code = `export const A = () => <div ${SOURCE_ATTRIBUTE}="custom:1" />;`;

    expect(injectSourceAttributes(code, 'src/A.tsx')).toBeNull();
  });

  it('handles typescript syntax in tsx modules', () => {
    const code = [
      'interface Props { label: string }',
      'export function Chip({ label }: Props): JSX.Element {',
      '  return <span title={label as string}>{label}</span>;',
      '}',
    ].join('\n');

    const result = injectSourceAttributes(code, 'src/Chip.tsx');
    expect(result?.code).toContain(`<span ${SOURCE_ATTRIBUTE}="src/Chip.tsx:3"`);
  });

  it('returns null for modules without host elements or with broken syntax', () => {
    expect(injectSourceAttributes('export const n = 1;', 'src/n.ts')).toBeNull();
    expect(injectSourceAttributes('const ??? = <div>;', 'src/broken.tsx')).toBeNull();
  });
});
