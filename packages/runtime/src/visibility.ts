/**
 * Whether the element is attached and actually rendered visible.
 *
 * Computed style of the element alone cannot answer this: `display` does
 * not inherit, so a child of a `display:none` ancestor still reports
 * `display: block` on itself. Prefer the native `Element.checkVisibility()`
 * (walks the ancestor chain in the engine); where it is unavailable (older
 * engines, jsdom) fall back to a manual ancestor walk for `display` —
 * `visibility` inherits, so the element's own computed value suffices.
 * Deliberately no bounding-rect check: jsdom reports all rects as zero,
 * which would make the runtime untestable.
 */
export function isElementVisible(element: Element): boolean {
  if (!element.isConnected) {
    return false;
  }
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ checkVisibilityCSS: true });
  }
  if (window.getComputedStyle(element).visibility === 'hidden') {
    return false;
  }
  // jsdom's default stylesheet does not map [hidden] to display:none, so
  // the attribute needs an explicit check alongside the style walk.
  if (element.closest('[hidden]') !== null) {
    return false;
  }
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (window.getComputedStyle(node).display === 'none') {
      return false;
    }
  }
  return true;
}
