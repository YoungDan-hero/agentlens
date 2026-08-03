import type { EventContext } from '../events';
import { buildLifecycleEvent } from '../events';
import type { EventSink } from '../transport';

/**
 * Reports SPA route changes as `navigation` lifecycle events. The History
 * API fires no event for pushState/replaceState, so both methods are
 * patched; popstate and hashchange cover the browser-initiated cases.
 * Returns a teardown function that restores the original methods.
 */
export function installNavigationCollector(sink: EventSink, context: EventContext): () => void {
  let lastUrl = window.location.href;

  const report = (): void => {
    // pushState can be called with the current URL (state-only updates);
    // only an actual URL change is a navigation. Isolated so a reporting
    // bug can never break the router that called pushState.
    try {
      if (window.location.href === lastUrl) {
        return;
      }
      lastUrl = window.location.href;
      sink.send(buildLifecycleEvent(context, 'navigation'));
    } catch {
      // Swallowed by design; navigation itself already happened.
    }
  };

  // Unbound originals so teardown restores exact function identity instead
  // of leaving a bound copy behind (which would stack per HMR cycle).
  /* eslint-disable @typescript-eslint/unbound-method -- restored as-is and invoked via .apply(history) */
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  /* eslint-enable @typescript-eslint/unbound-method */

  history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
    originalPushState.apply(this, args);
    report();
  };
  history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
    originalReplaceState.apply(this, args);
    report();
  };
  window.addEventListener('popstate', report);
  window.addEventListener('hashchange', report);

  return () => {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener('popstate', report);
    window.removeEventListener('hashchange', report);
  };
}
