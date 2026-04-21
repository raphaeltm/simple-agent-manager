/**
 * Trial cookie signing / verification.
 *
 * Two cookies are issued to anonymous trial visitors:
 *   - sam_trial_fingerprint  (7-day lifetime)   — signed UUID; identifies the same
 *                                                  anonymous visitor across subsequent page loads.
 *   - sam_trial_claim        (48-hour lifetime) — signed JSON payload
 *     { trialId, projectId, issuedAt, expiresAt } — presented on the OAuth callback
 *     so the API can re-parent `projects.user_id` from the sentinel system user to
 *     the newly-authenticated GitHub user.
 *
 * HMAC-SHA256, base64url, constant-time compare. The secret is a Worker secret
 * (`TRIAL_CLAIM_TOKEN_SECRET`) that MUST be set when trials are enabled.
 */

import {
  TRIAL_COOKIE_CLAIM_NAME,
  TRIAL_COOKIE_FINGERPRINT_NAME,
} from '@simple-agent-manager/shared';

// ---------------------------------------------------------------------------
// Defaults (Principle XI: all limits configurable, with DEFAULT_* constants)
// ---------------------------------------------------------------------------

export const DEFAULT_TRIAL_FINGERPRINT_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
export const DEFAULT_TRIAL_CLAIM_TTL_MS = 1000 * 60 * 60 * 48; // 48 hours

// ---------------------------------------------------------------------------
// Claim payload
// ---------------------------------------------------------------------------

export interface TrialClaimPayload {
  trialId: string;
  projectId: string;
  /** epoch ms — when the token was issued */
  issuedAt: number;
  /** epoch ms — absolute expiry */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

function base64urlEncode(bytes: Uint8Array): string {
  // btoa requires a binary string; Uint8Array iteration is safe for bytes.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64urlEncode(new Uint8Array(sig));
}

/** Constant-time comparison of two strings (prevents timing oracles on HMAC). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Fingerprint (signed UUID)
// ---------------------------------------------------------------------------

/**
 * Sign a fingerprint UUID — returns "<uuid>.<sig>" (dotted, base64url sig).
 * The value is opaque to callers; only `verifyFingerprint` re-reads it.
 */
export async function signFingerprint(
  uuid: string,
  secret: string
): Promise<string> {
  const sig = await hmacSign(secret, uuid);
  return `${uuid}.${sig}`;
}

/** Returns the UUID on success, or `null` if the signature is invalid. */
export async function verifyFingerprint(
  value: string,
  secret: string
): Promise<string | null> {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const uuid = value.slice(0, dot);
  const providedSig = value.slice(dot + 1);
  const expectedSig = await hmacSign(secret, uuid);
  return timingSafeEqual(providedSig, expectedSig) ? uuid : null;
}

// ---------------------------------------------------------------------------
// Claim token (signed JSON)
// ---------------------------------------------------------------------------

/**
 * Sign a claim payload — returns "<base64url(json)>.<sig>". The entire string
 * is then placed in the `sam_trial_claim` cookie.
 */
export async function signClaimToken(
  payload: TrialClaimPayload,
  secret: string
): Promise<string> {
  const body = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(secret, body);
  return `${body}.${sig}`;
}

export type ClaimVerifyFailure =
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'bad_signature' }
  | { ok: false; reason: 'expired' };

export type ClaimVerifyResult =
  | { ok: true; payload: TrialClaimPayload }
  | ClaimVerifyFailure;

/**
 * Verify a signed claim token. Returns the decoded payload or a reason tag on
 * failure. On `bad_signature` the provided HMAC did NOT match — constant-time
 * compared to prevent timing oracles.
 */
export async function verifyClaimToken(
  token: string,
  secret: string,
  now: number = Date.now()
): Promise<ClaimVerifyResult> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = await hmacSign(secret, body);
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: TrialClaimPayload;
  try {
    const json = new TextDecoder().decode(base64urlDecode(body));
    payload = JSON.parse(json) as TrialClaimPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload.trialId !== 'string' ||
    typeof payload.projectId !== 'string' ||
    typeof payload.issuedAt !== 'number' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (now >= payload.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Cookie string builders (HttpOnly; Secure; SameSite=Lax)
// ---------------------------------------------------------------------------

function buildCookieString(
  name: string,
  value: string,
  opts: { maxAgeSec: number; secure?: boolean; domain?: string }
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (opts.secure !== false) parts.push('Secure');
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join('; ');
}

export function buildFingerprintCookie(
  signedValue: string,
  opts: { secure?: boolean; domain?: string; maxAgeSec?: number } = {}
): string {
  return buildCookieString(TRIAL_COOKIE_FINGERPRINT_NAME, signedValue, {
    maxAgeSec: opts.maxAgeSec ?? DEFAULT_TRIAL_FINGERPRINT_TTL_SEC,
    secure: opts.secure,
    domain: opts.domain,
  });
}

export function buildClaimCookie(
  token: string,
  opts: { secure?: boolean; domain?: string; maxAgeSec?: number } = {}
): string {
  return buildCookieString(TRIAL_COOKIE_CLAIM_NAME, token, {
    maxAgeSec: opts.maxAgeSec ?? Math.floor(DEFAULT_TRIAL_CLAIM_TTL_MS / 1000),
    secure: opts.secure,
    domain: opts.domain,
  });
}

export function clearClaimCookie(opts: { domain?: string } = {}): string {
  // Max-Age=0 instructs the browser to drop the cookie immediately.
  return buildCookieString(TRIAL_COOKIE_CLAIM_NAME, '', {
    maxAgeSec: 0,
    secure: true,
    domain: opts.domain,
  });
}
