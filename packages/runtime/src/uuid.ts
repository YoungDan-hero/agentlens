/**
 * Generates an RFC 4122 v4 UUID. Uses `crypto.randomUUID` when available
 * and falls back to `crypto.getRandomValues` (available in insecure
 * contexts too), then to `Math.random` as a last resort.
 *
 * The fallback matters: `crypto.randomUUID` only exists in secure contexts
 * (https / localhost), so a dev server visited via a LAN IP over plain
 * http does not have it. The DOM types claim it is always present;
 * re-typing keeps the guard reachable for the type checker.
 */
export function generateId(): string {
  const cryptoObj = globalThis.crypto as Partial<Crypto> | undefined;
  if (typeof cryptoObj?.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Stamp the version (4) and variant (10xx) bits per RFC 4122.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
