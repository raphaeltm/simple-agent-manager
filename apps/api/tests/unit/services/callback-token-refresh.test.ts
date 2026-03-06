import { describe, expect, it } from 'vitest';
import { shouldRefreshCallbackToken } from '../../../src/services/jwt';
import type { Env } from '../../../src/index';

/**
 * Create a minimal JWT with given iat/exp claims.
 * This creates a structurally valid JWT (3 base64url segments) that jose's decodeJwt can parse.
 * No signature verification is needed since shouldRefreshCallbackToken only decodes.
 */
function makeTestToken(iat: number, exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat, exp, workspace: 'test', type: 'callback' })).toString('base64url');
  const signature = '';
  return `${header}.${payload}.${signature}`;
}

function makeEnv(ratio?: string): Env {
  return { CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO: ratio } as unknown as Env;
}

describe('shouldRefreshCallbackToken', () => {
  it('returns false for a fresh token (within first 50% of lifetime)', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued now, expires in 24 hours — well within threshold
    const token = makeTestToken(now, now + 86400);
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(false);
  });

  it('returns true for a token past 50% of its lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued 13 hours ago, expires in 11 hours — past 50%
    const token = makeTestToken(now - 13 * 3600, now + 11 * 3600);
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(true);
  });

  it('returns true for a token at exactly 50% of its lifetime', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued 12 hours ago, expires in 12 hours — exactly at 50%
    const token = makeTestToken(now - 12 * 3600, now + 12 * 3600);
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(true);
  });

  it('returns true for a nearly expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued 23 hours ago, expires in 1 hour
    const token = makeTestToken(now - 23 * 3600, now + 3600);
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(true);
  });

  it('returns true for an already expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token expired 1 hour ago
    const token = makeTestToken(now - 25 * 3600, now - 3600);
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(true);
  });

  it('respects custom refresh threshold ratio', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued 2 hours ago, expires in 22 hours (8.3% of 24h lifetime elapsed)
    const token = makeTestToken(now - 2 * 3600, now + 22 * 3600);

    // Default 0.5 threshold — should NOT refresh (8.3% < 50%)
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(false);

    // 0.08 threshold — clamped to 0.1, so 8.3% < 10% — should NOT refresh
    expect(shouldRefreshCallbackToken(token, makeEnv('0.08'))).toBe(false);

    // Token at 15% elapsed with 0.1 threshold — SHOULD refresh (15% >= 10%)
    const token15 = makeTestToken(now - Math.floor(3.6 * 3600), now + Math.floor(20.4 * 3600));
    expect(shouldRefreshCallbackToken(token15, makeEnv('0.1'))).toBe(true);
  });

  it('clamps ratio to valid range [0.1, 0.9]', () => {
    const now = Math.floor(Date.now() / 1000);
    // Token issued 2 hours ago (8.3% elapsed of 24h)
    const token = makeTestToken(now - 2 * 3600, now + 22 * 3600);

    // Ratio 0.01 should be clamped to 0.1 — 8.3% < 10%, so no refresh
    expect(shouldRefreshCallbackToken(token, makeEnv('0.01'))).toBe(false);

    // Ratio 0.99 should be clamped to 0.9 — 8.3% < 90%, so no refresh
    expect(shouldRefreshCallbackToken(token, makeEnv('0.99'))).toBe(false);
  });

  it('returns true for malformed tokens (safety fallback)', () => {
    expect(shouldRefreshCallbackToken('not-a-jwt', makeEnv())).toBe(true);
    expect(shouldRefreshCallbackToken('', makeEnv())).toBe(true);
  });

  it('returns true for tokens missing iat or exp claims', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ workspace: 'test' })).toString('base64url');
    const token = `${header}.${payload}.`;
    expect(shouldRefreshCallbackToken(token, makeEnv())).toBe(true);
  });
});
