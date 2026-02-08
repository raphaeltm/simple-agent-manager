/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) implementation
 * compatible with Cloudflare Workers.
 *
 * The `ulid` npm package uses Node.js `crypto.randomBytes` which fails in
 * Cloudflare Workers with "nodeCrypto.randomBytes is not a function".
 * This implementation uses the Web Crypto API (`crypto.getRandomValues`)
 * which is available in all Workers runtimes.
 *
 * Spec: https://github.com/ulid/spec
 * Format: TTTTTTTTTTRRRRRRRRRRRRRRRRR (26 chars, Crockford Base32)
 *   - T = timestamp (10 chars, 48-bit ms since Unix epoch)
 *   - R = randomness (16 chars, 80 bits)
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, length: number): string {
  let str = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = now % 32;
    str = CROCKFORD_BASE32[mod] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < length; i++) {
    str += CROCKFORD_BASE32[bytes[i]! % 32];
  }
  return str;
}

/**
 * Generate a ULID string.
 * Uses Web Crypto API for randomness (Cloudflare Workers compatible).
 */
export function ulid(): string {
  const now = Date.now();
  return encodeTime(now, 10) + encodeRandom(16);
}
