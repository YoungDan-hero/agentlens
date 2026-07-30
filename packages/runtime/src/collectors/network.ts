import type { EventContext } from '../events';
import { buildNetworkEvent } from '../events';
import { MAX_BODY_PARSE_BYTES, sanitizeBody } from '../redact';
import type { EventSink } from '../transport';

export interface NetworkCollectorOptions {
  /**
   * Capture request/response bodies (redacted and truncated). Off by
   * default: bodies may contain user data, so shipping them is opt-in.
   */
  captureBodies?: boolean;
  /**
   * WebSocket endpoints to ignore — the runtime's own daemon connection
   * must not observe itself (the transport reconnects with `new WebSocket`).
   */
  ignoreWebSocketUrls?: readonly string[];
}

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

/** Serializes the few body shapes that are cheap and safe to read. */
function serializeRequestBody(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  // Blob / FormData / ArrayBuffer / streams: reading would be costly or
  // destructive, and binary payloads are useless to an agent anyway.
  return null;
}

const TEXTUAL_CONTENT_TYPE = /json|text|xml|urlencoded/i;

function isReadableContentType(contentType: string): boolean {
  // SSE streams never end: clone().text() would hang forever and buffer
  // the stream in memory. They must never be drained.
  if (/event-stream/i.test(contentType)) {
    return false;
  }
  return TEXTUAL_CONTENT_TYPE.test(contentType);
}

async function readResponseBody(response: Response): Promise<string | null> {
  if (!isReadableContentType(response.headers.get('content-type') ?? '')) {
    return null;
  }
  // Oversized payloads would be discarded after redaction anyway; skip the
  // read entirely instead of buffering megabytes first.
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_PARSE_BYTES) {
    return `[body omitted: ${contentLength} bytes]`;
  }
  try {
    // Reading the clone leaves the caller's stream untouched.
    return await response.clone().text();
  } catch {
    return null;
  }
}

function installFetchInterceptor(
  sink: EventSink,
  context: EventContext,
  captureBodies: boolean,
): () => void {
  // Keep the original reference (not a bound copy) so teardown restores identity.
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    const initiatorStack = new Error().stack ?? null;
    const requestUrl = resolveRequestUrl(input);
    const method = resolveMethod(input, init);
    const requestBody = captureBodies ? serializeRequestBody(init) : null;

    const record = (status: number | null, responseBody: string | null): void => {
      sink.send(
        buildNetworkEvent(context, {
          transport: 'fetch',
          method,
          requestUrl,
          status,
          durationMs: Math.round(performance.now() - startedAt),
          initiatorStack,
          requestBody: requestBody === null ? null : sanitizeBody(requestBody),
          responseBody: responseBody === null ? null : sanitizeBody(responseBody),
        }),
      );
    };

    try {
      const response = await originalFetch.call(globalThis, input, init);
      if (captureBodies) {
        // Body reading is async; the caller gets the response immediately
        // and the event ships once the clone has been drained.
        void readResponseBody(response).then((body) => {
          record(response.status, body);
        });
      } else {
        record(response.status, null);
      }
      return response;
    } catch (error) {
      // Transport-level failure (DNS, CORS, offline): no status exists.
      record(null, null);
      throw error;
    }
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installXhrInterceptor(
  sink: EventSink,
  context: EventContext,
  captureBodies: boolean,
): () => void {
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
      const rawBody = args[0];
      const requestBody = captureBodies && typeof rawBody === 'string' ? rawBody : null;
      // `loadend` fires exactly once for success, HTTP errors, network
      // failures, timeouts and aborts alike.
      this.addEventListener(
        'loadend',
        () => {
          let responseBody: string | null = null;
          if (captureBodies && (this.responseType === '' || this.responseType === 'text')) {
            try {
              responseBody = this.responseText;
            } catch {
              responseBody = null;
            }
          }
          sink.send(
            buildNetworkEvent(context, {
              transport: 'xhr',
              method: info.method,
              requestUrl: info.url,
              // Status 0 means the request never got an HTTP response
              // (network failure, timeout, abort).
              status: this.status === 0 ? null : this.status,
              durationMs: Math.round(performance.now() - startedAt),
              initiatorStack,
              requestBody: requestBody === null ? null : sanitizeBody(requestBody),
              responseBody:
                responseBody === null || responseBody === '' ? null : sanitizeBody(responseBody),
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

function normalizeWsUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function installWebSocketInterceptor(
  sink: EventSink,
  context: EventContext,
  ignoreUrls: readonly string[],
): () => void {
  const OriginalWebSocket = globalThis.WebSocket;
  const ignored = new Set(ignoreUrls.map(normalizeWsUrl));

  class InstrumentedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const requestUrl = url instanceof URL ? url.href : url;
      if (ignored.has(normalizeWsUrl(requestUrl))) {
        return;
      }
      const startedAt = performance.now();
      const initiatorStack = new Error().stack ?? null;
      let reported = false;
      const report = (status: number | null): void => {
        if (reported) {
          return;
        }
        reported = true;
        sink.send(
          buildNetworkEvent(context, {
            transport: 'websocket',
            method: 'WS',
            requestUrl,
            // 101 Switching Protocols marks a successful upgrade; a close
            // before open means the connection never established.
            status,
            durationMs: Math.round(performance.now() - startedAt),
            initiatorStack,
          }),
        );
      };
      this.addEventListener(
        'open',
        () => {
          report(101);
        },
        { once: true },
      );
      this.addEventListener(
        'close',
        () => {
          report(null);
        },
        { once: true },
      );
    }
  }

  globalThis.WebSocket = InstrumentedWebSocket;
  return () => {
    globalThis.WebSocket = OriginalWebSocket;
  };
}

function installBeaconInterceptor(
  sink: EventSink,
  context: EventContext,
  captureBodies: boolean,
): () => void {
  const nav = navigator;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- original is always invoked via .call(nav) below
  const originalSendBeacon = nav.sendBeacon;

  nav.sendBeacon = function (this: Navigator, url: string | URL, data?: BodyInit | null): boolean {
    const initiatorStack = new Error().stack ?? null;
    const queued = originalSendBeacon.call(this, url, data);
    sink.send(
      buildNetworkEvent(context, {
        transport: 'beacon',
        method: 'POST',
        requestUrl: url instanceof URL ? url.href : url,
        // Beacons are fire-and-forget: the browser never exposes a response.
        status: null,
        durationMs: 0,
        initiatorStack,
        requestBody:
          captureBodies && typeof data === 'string' && data !== '' ? sanitizeBody(data) : null,
      }),
    );
    return queued;
  };

  return () => {
    nav.sendBeacon = originalSendBeacon;
  };
}

/**
 * Records the outcome and duration of every network operation: `fetch`,
 * `XMLHttpRequest` (axios' default browser adapter), WebSocket connection
 * attempts and `navigator.sendBeacon` calls. The stack captured at call time
 * lets the daemon attribute each request to its initiator. Returns a
 * teardown function.
 */
export function installNetworkCollector(
  sink: EventSink,
  context: EventContext,
  options: NetworkCollectorOptions = {},
): () => void {
  const captureBodies = options.captureBodies ?? false;
  const teardowns = [installFetchInterceptor(sink, context, captureBodies)];
  if (typeof XMLHttpRequest !== 'undefined') {
    teardowns.push(installXhrInterceptor(sink, context, captureBodies));
  }
  if (typeof WebSocket !== 'undefined') {
    teardowns.push(installWebSocketInterceptor(sink, context, options.ignoreWebSocketUrls ?? []));
  }
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    teardowns.push(installBeaconInterceptor(sink, context, captureBodies));
  }
  return () => {
    for (const teardown of teardowns) {
      teardown();
    }
  };
}
