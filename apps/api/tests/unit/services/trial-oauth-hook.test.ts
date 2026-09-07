/**
 * Unit tests for the OAuth-callback trial-claim hook.
 *
 * Covers:
 *   - Non-callback URL → response returned untouched
 *   - Non-2xx/3xx response → untouched
 *   - Missing fingerprint cookie → untouched
 *   - Fingerprint cookie with bad signature → untouched
 *   - No trial record matches fingerprint → untouched
 *   - Claimed trial → untouched
 *   - Expired trial → untouched
 *   - Secret unset (TRIAL_CLAIM_TOKEN_SECRET missing) → untouched
 *   - Happy path → sets claim cookie, rewrites Location to
 *     https://app.${BASE_DOMAIN}/try/${trialId}?claim=1
 */
import { describe, expect, it, vi } from 'vitest';

// Silence the logger
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the trial-store read by fingerprint
const { readTrialByFingerprintMock } = vi.hoisted(() => ({
  readTrialByFingerprintMock: vi.fn(),
}));
vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrialByFingerprint: readTrialByFingerprintMock,
}));

import type { Env } from '../../../src/env';
import {
  buildFingerprintCookie,
  signClaimToken,
  signFingerprint,
  verifyClaimToken,
} from '../../../src/services/trial/cookies';
import { maybeAttachTrialClaimCookie } from '../../../src/services/trial/oauth-hook';

const SECRET = 'test-secret-at-least-32-bytes-long-for-hmac-verification';

function envWith(overrides: Partial<Env> = {}): Env {
  return {
    TRIAL_CLAIM_TOKEN_SECRET: SECRET,
    BASE_DOMAIN: 'example.com',
    ...overrides,
  } as unknown as Env;
}

function makeRedirectResponse(location = 'https://app.example.com/'): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}

function makeRequestWithFingerprint(
  path: string,
  signedCookie: string | null
): Request {
  const headers = new Headers();
  if (signedCookie) {
    headers.set('cookie', `sam_trial_fingerprint=${encodeURIComponent(signedCookie)}`);
  }
  return new Request(`https://api.example.com${path}`, { headers });
}

describe('maybeAttachTrialClaimCookie — bail-out cases', () => {
  it('returns response untouched when URL is not /callback/github', async () => {
    const env = envWith();
    const req = new Request('https://api.example.com/api/auth/session');
    const resp = makeRedirectResponse();
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when status is 4xx', async () => {
    const env = envWith();
    const req = new Request('https://api.example.com/api/auth/callback/github');
    const resp = new Response('bad', { status: 400 });
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when status is 5xx', async () => {
    const env = envWith();
    const req = new Request('https://api.example.com/api/auth/callback/github');
    const resp = new Response('err', { status: 500 });
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when TRIAL_CLAIM_TOKEN_SECRET is unset', async () => {
    const env = envWith({ TRIAL_CLAIM_TOKEN_SECRET: undefined } as Partial<Env>);
    const req = makeRequestWithFingerprint('/api/auth/callback/github', 'fake.sig');
    const resp = makeRedirectResponse();
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when no fingerprint cookie present', async () => {
    const env = envWith();
    const req = makeRequestWithFingerprint('/api/auth/callback/github', null);
    const resp = makeRedirectResponse();
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when fingerprint signature is invalid', async () => {
    const env = envWith();
    const req = makeRequestWithFingerprint(
      '/api/auth/callback/github',
      'bogus-uuid.not-a-real-signature'
    );
    const resp = makeRedirectResponse();
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when no trial record matches fingerprint', async () => {
    const env = envWith();
    const signed = await signFingerprint('fp-uuid-1', SECRET);
    const req = makeRequestWithFingerprint('/api/auth/callback/github', signed);
    const resp = makeRedirectResponse();

    readTrialByFingerprintMock.mockResolvedValueOnce(null);
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when trial is already claimed', async () => {
    const env = envWith();
    const signed = await signFingerprint('fp-uuid-2', SECRET);
    const req = makeRequestWithFingerprint('/api/auth/callback/github', signed);
    const resp = makeRedirectResponse();

    readTrialByFingerprintMock.mockResolvedValueOnce({
      trialId: 'trial_x',
      projectId: 'proj_x',
      fingerprint: 'fp-uuid-2',
      claimed: true,
      expiresAt: Date.now() + 60_000,
    });
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });

  it('returns response untouched when trial has expired', async () => {
    const env = envWith();
    const signed = await signFingerprint('fp-uuid-3', SECRET);
    const req = makeRequestWithFingerprint('/api/auth/callback/github', signed);
    const resp = makeRedirectResponse();

    readTrialByFingerprintMock.mockResolvedValueOnce({
      trialId: 'trial_y',
      projectId: 'proj_y',
      fingerprint: 'fp-uuid-3',
      claimed: false,
      expiresAt: Date.now() - 1000, // already expired
    });
    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).toBe(resp);
  });
});

describe('maybeAttachTrialClaimCookie — happy path', () => {
  it('sets claim cookie and rewrites Location to app.${BASE_DOMAIN}/try/:trialId?claim=1', async () => {
    const env = envWith({ BASE_DOMAIN: 'sammy.party' } as Partial<Env>);
    const signed = await signFingerprint('fp-uuid-99', SECRET);
    const req = makeRequestWithFingerprint('/api/auth/callback/github', signed);
    const resp = makeRedirectResponse('https://api.sammy.party/callback-result');

    readTrialByFingerprintMock.mockResolvedValueOnce({
      trialId: 'trial_zzz',
      projectId: 'proj_zzz',
      fingerprint: 'fp-uuid-99',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });

    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result).not.toBe(resp);
    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe(
      'https://app.sammy.party/try/trial_zzz?claim=1'
    );

    // Set-Cookie must contain a claim cookie (sam_trial_claim=<token>...)
    const setCookie = result.headers.get('Set-Cookie');
    expect(setCookie).toContain('sam_trial_claim=');

    // Extract token from cookie to verify it's a valid signed claim
    const match = /sam_trial_claim=([^;]+)/.exec(setCookie ?? '');
    expect(match).not.toBeNull();
    const token = decodeURIComponent(match![1]!);
    const verified = await verifyClaimToken(token, SECRET);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.trialId).toBe('trial_zzz');
      expect(verified.payload.projectId).toBe('proj_zzz');
    }
  });

  it('preserves other response headers when rewriting the response', async () => {
    const env = envWith({ BASE_DOMAIN: 'sammy.party' } as Partial<Env>);
    const signed = await signFingerprint('fp-uuid-100', SECRET);
    const req = makeRequestWithFingerprint('/api/auth/callback/github', signed);
    const resp = new Response(null, {
      status: 302,
      headers: {
        Location: '/somewhere',
        'X-Custom-Header': 'preserved',
      },
    });

    readTrialByFingerprintMock.mockResolvedValueOnce({
      trialId: 'trial_h',
      projectId: 'proj_h',
      fingerprint: 'fp-uuid-100',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });

    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result.headers.get('X-Custom-Header')).toBe('preserved');
  });
});

// Sanity: confirm `signFingerprint + buildFingerprintCookie` produce a value
// that survives our test helper's `decodeURIComponent` trip through a cookie.
describe('maybeAttachTrialClaimCookie — cookie parsing', () => {
  it('parses a full Set-Cookie-style fingerprint header correctly', async () => {
    const env = envWith();
    const signed = await signFingerprint('fp-uuid-cookie', SECRET);
    const cookieHeader = buildFingerprintCookie(signed, { secure: false });

    // Build a request whose Cookie header is the just-built Set-Cookie value's
    // name=value portion only (simulating browser behavior).
    const value = cookieHeader.split(';')[0]!; // "sam_trial_fingerprint=<signed>"
    const req = new Request('https://api.example.com/api/auth/callback/github', {
      headers: { cookie: value },
    });
    const resp = makeRedirectResponse('https://api.example.com/');

    readTrialByFingerprintMock.mockResolvedValueOnce({
      trialId: 'trial_cookie',
      projectId: 'proj_cookie',
      fingerprint: 'fp-uuid-cookie',
      claimed: false,
      expiresAt: Date.now() + 60_000,
    });

    const result = await maybeAttachTrialClaimCookie(env, req, resp);
    expect(result.headers.get('Location')).toContain('/try/trial_cookie?claim=1');
    // Ensure the trial-store was queried with the DECODED UUID
    expect(readTrialByFingerprintMock).toHaveBeenCalledWith(env, 'fp-uuid-cookie');
  });
});

// Also sanity-check the signClaimToken import so lint doesn't complain.
signClaimToken;
