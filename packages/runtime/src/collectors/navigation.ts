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
    // only an actual URL change is a navigation.
    if (window.location.href === lastUrl) {
      return;
    }
    lastUrl = window.location.href;
    sink.send(buildLifecycleEvent(context, 'navigation'));
  };

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args: Parameters<History['pushState']>) => {
    originalPushState(...args);
    report();
  };
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    originalReplaceState(...args);
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
