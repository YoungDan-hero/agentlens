/**
 * Redaction helpers keeping sensitive data out of captured events.
 *
 * Philosophy: privacy by design. Request headers are never captured at all;
 * this module covers the two remaining exposure surfaces — URL query
 * parameters (always redacted) and request/response bodies (only captured
 * when the user opts in, and redacted even then). False positives are
 * acceptable for a dev-time tool; leaking a credential is not.
 */

export const REDACTED = '[REDACTED]';

/**
 * Key names whose values must never leave the browser. `authorization` is
 * listed explicitly because the generic `auth(?!or)` alternative must keep
 * "author"-like fields readable.
 */
const SENSITIVE_KEY_PATTERN =
  /pass(word|wd)?|pwd|secret|token|credential|cookie|session|api[-_]?key|authorization|auth(?!or)/i;

let extraKeyNeedles: readonly string[] = [];

/**
 * Registers project-specific sensitive key needles on top of the built-in
 * pattern (same semantics: case-insensitive substring match). Wired up from
 * `init({ redactKeys })`; calling again replaces the previous set.
 */
export function setExtraRedactKeys(keys: readonly string[]): void {
  extraKeyNeedles = keys.map((key) => key.trim().toLowerCase()).filter((key) => key.length > 0);
}

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return true;
  }
  if (extraKeyNeedles.length === 0) {
    return false;
  }
  const lower = key.toLowerCase();
  return extraKeyNeedles.some((needle) => lower.includes(needle));
}

/** Redacts sensitive parameters in one query-carrying segment (`...?a=b&c=d`). */
function redactQuerySegment(segment: string): string {
  const queryStart = segment.indexOf('?');
  if (queryStart === -1) {
    return segment;
  }
  const params = new URLSearchParams(segment.slice(queryStart + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (isSensitiveKey(key)) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? `${segment.slice(0, queryStart + 1)}${params.toString()}` : segment;
}

/**
 * Replaces the values of sensitive query parameters with `[REDACTED]`,
 * preserving the rest of the URL byte-for-byte (including relative form)
 * when nothing matches. The search part and the hash fragment are redacted
 * independently: hash routers carry their own query (`#/route?token=...`),
 * which can coexist with a real search query (e.g. an SSO callback landing
 * on a hash-routed page).
 */
export function redactUrl(url: string): string {
  const hashStart = url.indexOf('#');
  if (hashStart === -1) {
    return redactQuerySegment(url);
  }
  return redactQuerySegment(url.slice(0, hashStart)) + redactQuerySegment(url.slice(hashStart));
}

const MAX_REDACT_DEPTH = 32;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  // Beyond the depth cap the walk stops — the subtree must be dropped, not
  // passed through: an unredacted deep branch could carry a credential
  // verbatim into the shipped body.
  if (depth > MAX_REDACT_DEPTH) {
    return '[MaxDepth]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  // Null prototype so a "__proto__" key is stored as a plain entry instead
  // of triggering the prototype setter (which would drop the field).
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1);
  }
  return result;
}

/** Heuristic for `application/x-www-form-urlencoded` payloads. */
function looksUrlEncoded(text: string): boolean {
  return /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text);
}

/**
 * Redacts sensitive fields inside a body. JSON bodies are parsed and walked
 * (nested objects and arrays included); form-urlencoded bodies are treated
 * like a query string. Anything else passes through unchanged.
 */
export function redactBodyText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactValue(JSON.parse(trimmed), 0));
    } catch {
      return text;
    }
  }
  if (looksUrlEncoded(trimmed)) {
    const params = new URLSearchParams(trimmed);
    let changed = false;
    for (const key of [...params.keys()]) {
      if (isSensitiveKey(key)) {
        params.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? params.toString() : text;
  }
  return text;
}

/** Bodies larger than this are not parsed or shipped at all. */
export const MAX_BODY_PARSE_BYTES = 64 * 1024;
/** Redacted bodies are truncated to this many characters before shipping. */
export const MAX_BODY_LENGTH = 4096;

/**
 * Full pipeline for an outgoing body string: size guard, field redaction,
 * truncation. Returns a shippable string or a placeholder for oversized
 * payloads.
 */
export function sanitizeBody(text: string): string {
  if (text.length > MAX_BODY_PARSE_BYTES) {
    return `[body omitted: ${String(text.length)} chars]`;
  }
  const redacted = redactBodyText(text);
  return redacted.length > MAX_BODY_LENGTH ? `${redacted.slice(0, MAX_BODY_LENGTH)}…` : redacted;
}
