import type { EventContext } from '../events';
import { buildNetworkEvent } from '../events';
import type { EventSink } from '../transport';

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function resolveMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method !== undefined) {
    return init.method.toUpperCase();
  }
  if (input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

/**
 * Wraps `fetch` to record request outcome and duration. The stack captured
 * at call time lets the daemon attribute the request to its initiator.
 * Returns a teardown function. XHR interception is intentionally deferred.
 */
export function installNetworkCollector(sink: EventSink, context: EventContext): () => void {
  // Keep the original reference (not a bound copy) so teardown restores identity.
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    const initiatorStack = new Error().stack ?? null;
    const requestUrl = resolveRequestUrl(input);
    const method = resolveMethod(input, init);

    const record = (status: number | null): void => {
      sink.send(
        buildNetworkEvent(context, {
          method,
          requestUrl,
          status,
          durationMs: Math.round(performance.now() - startedAt),
          initiatorStack,
        }),
      );
    };

    try {
      const response = await originalFetch.call(globalThis, input, init);
      record(response.status);
      return response;
    } catch (error) {
      // Transport-level failure (DNS, CORS, offline): no status exists.
      record(null);
      throw error;
    }
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}
