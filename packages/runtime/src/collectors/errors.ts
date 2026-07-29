import type { EventContext } from '../events';
import { buildErrorEvent } from '../events';
import type { EventSink } from '../transport';

/**
 * Captures uncaught exceptions and unhandled promise rejections.
 * Returns a teardown function so HMR updates can re-install cleanly.
 */
export function installErrorCollector(sink: EventSink, context: EventContext): () => void {
  const onError = (event: globalThis.ErrorEvent): void => {
    const error: unknown = event.error;
    sink.send(
      buildErrorEvent(context, {
        subtype: 'uncaught',
        message: event.message,
        stack: error instanceof Error ? (error.stack ?? null) : null,
      }),
    );
  };

  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    sink.send(
      buildErrorEvent(context, {
        subtype: 'unhandledrejection',
        message,
        stack: reason instanceof Error ? (reason.stack ?? null) : null,
      }),
    );
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
