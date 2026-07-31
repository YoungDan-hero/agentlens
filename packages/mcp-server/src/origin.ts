/**
 * Browser-layer guard for the ingest endpoint.
 *
 * Binding to 127.0.0.1 stops other machines, but not other pages: the
 * WebSocket handshake is not subject to CORS, so any website open in the
 * user's browser could connect to the loopback daemon and inject forged
 * events — which would flow straight into an AI agent's context (a prompt
 * injection vector). Browsers attach an unforgeable `Origin` header to
 * every WebSocket handshake, so restricting it to local dev origins closes
 * that hole without any pairing ceremony.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * RFC 1918 ranges: dev servers are commonly opened via their LAN IP.
 * Anchored end-to-end so domains like `192.168.1.1.evil.com` cannot pass.
 */
const PRIVATE_IPV4 = /^(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}$/;

/** Parses the comma-separated `AGENTLENS_ALLOWED_ORIGINS` env variable. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter((origin) => origin.length > 0);
}

/**
 * Whether a WebSocket handshake with this `Origin` header may connect.
 *
 * - No header: allowed. Non-browser clients (tests, CLI tools) omit it,
 *   and the threat model is web pages, which always send one.
 * - Loopback, `*.localhost` and RFC 1918 private hosts: allowed, covering
 *   dev servers opened via `localhost` or a LAN IP on the same machine.
 * - Everything else (public websites, `null` from sandboxed iframes):
 *   rejected unless explicitly listed in `extraAllowed`.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  extraAllowed: readonly string[] = [],
): boolean {
  if (origin === undefined || origin === '') {
    return true;
  }
  if (extraAllowed.includes(origin)) {
    return true;
  }
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    // Covers the literal "null" origin (sandboxed iframes, file://).
    return false;
  }
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    PRIVATE_IPV4.test(hostname)
  );
}
