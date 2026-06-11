/**
 * Minimal HS256 JWT sign/verify on WebCrypto, shaped after the Docker
 * registry token spec: the token carries an `access` claim listing the
 * repositories and actions it grants.
 */

export interface RegistryAccess {
  type: 'repository';
  name: string;
  actions: string[];
}

export interface RegistryTokenClaims {
  /** SAM project ID the token is scoped to. */
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  access: RegistryAccess[];
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  // Base64 padding is at most 2 chars; the bounded quantifier avoids
  // super-linear regex backtracking (SonarCloud S5852).
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/={1,2}$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Cache the imported CryptoKey per secret so we don't pay the importKey cost
// on every request (the secret is stable for the lifetime of the worker).
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    keyCache.set(secret, key);
  }
  return key;
}

export async function signRegistryToken(claims: RegistryTokenClaims, secret: string): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface ExpectedTokenContext {
  issuer: string;
  audience: string;
}

export async function verifyRegistryToken(
  token: string,
  secret: string,
  expected: ExpectedTokenContext
): Promise<RegistryTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;
  // Reject algorithm-confusion attacks: only HS256 is ever issued, so any
  // other (or missing) alg in the header means the token is not ours.
  try {
    const parsedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { alg?: unknown };
    if (parsedHeader.alg !== 'HS256') {
      return null;
    }
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(signature) as unknown as ArrayBuffer & Uint8Array,
      new TextEncoder().encode(`${header}.${payload}`)
    );
  } catch {
    return null;
  }
  if (!valid) {
    return null;
  }
  let claims: RegistryTokenClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as RegistryTokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) {
    return null;
  }
  if (typeof claims.sub !== 'string' || !Array.isArray(claims.access)) {
    return null;
  }
  if (claims.iss !== expected.issuer || claims.aud !== expected.audience) {
    return null;
  }
  return claims;
}
