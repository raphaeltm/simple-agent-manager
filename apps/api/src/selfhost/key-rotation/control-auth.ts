/**
 * Authentication of the self-hosted key-rotation control endpoint (control.ts), shared by the
 * Worker (verifies) and `pnpm selfhost:secrets rotate` (signs). Web Crypto only, no app imports,
 * so the box-side CLI can use it as is.
 *
 * The key is SAM_KEY_ROTATION_CONTROL_KEY: 32 random bytes generated for one rotation and present
 * only in that rotation's transitional bundles, so the endpoint does not exist at any other time.
 * Header: `x-sam-key-rotation: v1.<unix seconds>.<nonce hex>.<base64url HMAC-SHA256>` over
 * `v1\n<seconds>\n<nonce>\n<sha256 hex of the body>`, accepted within CLOCK_SKEW_SECONDS.
 * Requests are idempotent (a replayed page re-reads and re-checks), so nonces are not stored.
 */

export const KEY_ROTATION_PATH = '/__sam-selfhost/key-rotation';
export const KEY_ROTATION_AUTH_HEADER = 'x-sam-key-rotation';
export const CLOCK_SKEW_SECONDS = 120;
const VERSION = 'v1';

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCodePoint(byte);
  // base64 padding only ever trails the string, so dropping every '=' strips exactly it.
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function mac(key: string, seconds: string, nonce: string, body: string): Promise<string> {
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', encoder.encode(body)));
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const message = `${VERSION}\n${seconds}\n${nonce}\n${bodyHash}`;
  return base64Url(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(message)));
}

export async function signKeyRotationRequest(
  key: string,
  body: string,
  nowMs: number = Date.now()
): Promise<string> {
  const seconds = String(Math.floor(nowMs / 1000));
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `${VERSION}.${seconds}.${nonce}.${await mac(key, seconds, nonce, body)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

export async function verifyKeyRotationRequest(
  key: string,
  header: string | null,
  body: string,
  nowMs: number = Date.now()
): Promise<boolean> {
  if (!key || !header) return false;
  const parts = header.split('.');
  if (parts.length !== 4) return false;
  const [version, seconds, nonce, presented] = parts as [string, string, string, string];
  if (version !== VERSION || !/^\d{1,12}$/.test(seconds) || !/^[0-9a-f]{32}$/.test(nonce)) {
    return false;
  }
  if (Math.abs(Number(seconds) - nowMs / 1000) > CLOCK_SKEW_SECONDS) return false;
  return constantTimeEqual(presented, await mac(key, seconds, nonce, body));
}
