// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { isElementVisible } from './visibility';

describe('isElementVisible', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports detached elements as not visible', () => {
    const element = document.createElement('div');
    expect(isElementVisible(element)).toBe(false);
  });

  it('prefers the native checkVisibility when the engine provides it', () => {
    document.body.innerHTML = '<div id="x">x</div>';
    const element = document.getElementById('x') as Element;
    // jsdom has no checkVisibility; grafting one proves the native path
    // wins over the style fallback (the element looks visible by style).
    let calls = 0;
    (element as { checkVisibility?: () => boolean }).checkVisibility = () => {
      calls += 1;
      return false;
    };
    expect(isElementVisible(element)).toBe(false);
    expect(calls).toBe(1);
  });

  it('fallback: detects visibility:hidden on the element itself', () => {
    document.body.innerHTML = '<div id="x" style="visibility:hidden">x</div>';
    expect(isElementVisible(document.getElementById('x') as Element)).toBe(false);
  });

  it('fallback: detects a [hidden] ancestor', () => {
    document.body.innerHTML = '<div hidden><span id="x">x</span></div>';
    expect(isElementVisible(document.getElementById('x') as Element)).toBe(false);
  });

  it('fallback: detects a display:none ancestor via the style walk', () => {
    document.body.innerHTML = '<div style="display:none"><span id="x">x</span></div>';
    expect(isElementVisible(document.getElementById('x') as Element)).toBe(false);
  });

  it('fallback: reports normally rendered elements as visible', () => {
    document.body.innerHTML = '<button id="x">go</button>';
    expect(isElementVisible(document.getElementById('x') as Element)).toBe(true);
  });
});
