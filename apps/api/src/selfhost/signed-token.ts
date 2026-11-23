/**
 * Short-lived tokens the self-host Worker signs for itself: `<prefix>.<payload>.<signature>`, a
 * base64url JSON payload signed with HMAC-SHA256.
 *
 * Each purpose has its own key, derived from the Worker's ENCRYPTION_KEY with HKDF under a fixed
 * label, so a token minted for one purpose never verifies for another and no new secret or table
 * is needed. The key therefore rotates with ENCRYPTION_KEY (`pnpm selfhost:secrets rotate`). A
 * purpose that accepts `ENCRYPTION_KEY_PREVIOUS` keeps tokens minted just before a rotation valid
 * while the rotation overlaps (they are minutes long).
 *
 * Users: SAM-hosted git (`hosted-git/tokens.ts`) and box object URLs (`object-urls/tokens.ts`).
 */
export interface SignedTokenPurpose {
  /** First token segment, for example `samgit1`. */
  prefix: string;
  /** HKDF info label; no other purpose may share it. */
  label: string;
  /** Also verify with ENCRYPTION_KEY_PREVIOUS (signing always uses ENCRYPTION_KEY). */
  acceptPreviousKey?: boolean;
}

export interface SignedTokenEnv {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_PREVIOUS?: string;
}

/** Longest token any purpose verifies; longer input is refused before any crypto. */
const MAX_TOKEN_LENGTH = 2048;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Derived keys, cached once derived, per (label, secret). Only a finished key is shared: a request
 * never waits on a derivation another request started, which on the self-hosted celld runtime
 * could be dropped with that request (lib/shared-flight.ts). Concurrent cold callers each derive
 * once (one HKDF).
 */
const cachedKeys = new Map<string, { secret: string; key: CryptoKey }[]>();
/** Per label: the current and the previous ENCRYPTION_KEY. */
const MAX_CACHED_KEYS_PER_LABEL = 2;

async function signingKey(label: string, secret: string): Promise<CryptoKey> {
  const cached = cachedKeys.get(label) ?? [];
  const hit = cached.find((entry) => entry.secret === secret);
  if (hit) return hit.key;
  const root = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(label) },
    root,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify']
  );
  // A rotation replaces the oldest entry, so retired keys do not accumulate for the isolate's life.
  cachedKeys.set(label, [{ secret, key }, ...cached].slice(0, MAX_CACHED_KEYS_PER_LABEL));
  return key;
}

function requireKey(env: Pick<SignedTokenEnv, 'ENCRYPTION_KEY'>, purpose: SignedTokenPurpose) {
  if (!env.ENCRYPTION_KEY)
    throw new Error(`ENCRYPTION_KEY is required for ${purpose.prefix} tokens`);
  return env.ENCRYPTION_KEY;
}

/** Signs `claims` (any JSON object) for `purpose` with ENCRYPTION_KEY. */
export async function mintSignedToken(
  env: Pick<SignedTokenEnv, 'ENCRYPTION_KEY'>,
  purpose: SignedTokenPurpose,
  claims: object
): Promise<string> {
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(claims)));
  const unsigned = `${purpose.prefix}.${payload}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(purpose.label, requireKey(env, purpose)),
    encoder.encode(unsigned)
  );
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * The parsed payload of a token whose signature verifies for `purpose`, or null. Callers validate
 * the payload's shape and expiry themselves.
 */
export async function verifySignedToken(
  env: SignedTokenEnv,
  purpose: SignedTokenPurpose,
  token: string
): Promise<Record<string, unknown> | null> {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== purpose.prefix) return null;
  const [prefix, payload, signaturePart] = parts as [string, string, string];
  const signature = base64UrlDecode(signaturePart);
  const payloadBytes = base64UrlDecode(payload);
  if (!signature || !payloadBytes) return null;
  const secrets = [requireKey(env, purpose)];
  if (purpose.acceptPreviousKey && env.ENCRYPTION_KEY_PREVIOUS) {
    secrets.push(env.ENCRYPTION_KEY_PREVIOUS);
  }
  let valid = false;
  for (const secret of secrets) {
    valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(purpose.label, secret),
      signature,
      encoder.encode(`${prefix}.${payload}`)
    );
    if (valid) break;
  }
  if (!valid) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
