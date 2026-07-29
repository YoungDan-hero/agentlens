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

function installFetchInterceptor(sink: EventSink, context: EventContext): () => void {
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

function installXhrInterceptor(sink: EventSink, context: EventContext): () => void {
  const proto = XMLHttpRequest.prototype;
  // Prototype patching needs the unbound originals: they are always invoked
  // via .apply(this) on a live XHR instance below.
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalOpen = proto.open;
  const originalSend = proto.send;
  /* eslint-enable @typescript-eslint/unbound-method */
  const pending = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

  proto.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    pending.set(this, {
      method: method.toUpperCase(),
      url: url instanceof URL ? url.href : url,
    });
    // The 2-arg overload must stay 2-arg: passing `undefined` as `async`
    // would coerce to `false` and silently turn the request synchronous.
    // (.call resolves against the 5-arg overload only, hence the narrowing.)
    if (async === undefined) {
      const openTwoArg: (this: XMLHttpRequest, method: string, url: string | URL) => void =
        originalOpen;
      openTwoArg.call(this, method, url);
    } else {
      originalOpen.call(this, method, url, async, username, password);
    }
  };

  proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
    const info = pending.get(this);
    if (info) {
      // Consume the record: an (invalid) second send() without a re-open
      // must not register a duplicate listener for the in-flight request.
      pending.delete(this);
      const startedAt = performance.now();
      const initiatorStack = new Error().stack ?? null;
      // `loadend` fires exactly once for success, HTTP errors, network
      // failures, timeouts and aborts alike.
      this.addEventListener(
        'loadend',
        () => {
          sink.send(
            buildNetworkEvent(context, {
              method: info.method,
              requestUrl: info.url,
              // Status 0 means the request never got an HTTP response
              // (network failure, timeout, abort).
              status: this.status === 0 ? null : this.status,
              durationMs: Math.round(performance.now() - startedAt),
              initiatorStack,
            }),
          );
        },
        { once: true },
      );
    }
    originalSend.apply(this, args);
  };

  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
  };
}

/**
 * Records the outcome and duration of every network request, covering both
 * `fetch` and `XMLHttpRequest` (used by axios' default browser adapter,
 * among others). The stack captured at call time lets the daemon attribute
 * each request to its initiator. Returns a teardown function.
 */
export function installNetworkCollector(sink: EventSink, context: EventContext): () => void {
  const teardowns = [installFetchInterceptor(sink, context)];
  if (typeof XMLHttpRequest !== 'undefined') {
    teardowns.push(installXhrInterceptor(sink, context));
  }
  return () => {
    for (const teardown of teardowns) {
      teardown();
    }
  };
}
