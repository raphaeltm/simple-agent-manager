import { exportPKCS8, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  callbackTokenIssuedAtMs,
  DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS,
  getInstantStaleCallbackMarginMs,
  isSupersededInstantCallback,
} from '../../../src/routes/_stale-callback-guard';
import { signCallbackToken } from '../../../src/services/jwt';

function jwtWith(payload: Record<string, unknown>): string {
  const seg = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'RS256', typ: 'JWT' })}.${seg(payload)}.sig`;
}

const IAT_SECONDS = 1_700_000_000;
const IAT_MS = IAT_SECONDS * 1000;
const MARGIN = DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS;
const iso = (ms: number) => new Date(ms).toISOString();

describe('callbackTokenIssuedAtMs', () => {
  it('returns iat in ms for a decodable token', () => {
    expect(callbackTokenIssuedAtMs(jwtWith({ iat: IAT_SECONDS }))).toBe(IAT_MS);
  });

  it('returns null for a non-JWT string', () => {
    expect(callbackTokenIssuedAtMs('not-a-jwt')).toBeNull();
  });

  it('returns null when iat is absent or non-numeric', () => {
    expect(callbackTokenIssuedAtMs(jwtWith({ workspace: 'ws-1' }))).toBeNull();
    expect(callbackTokenIssuedAtMs(jwtWith({ iat: 'nope' }))).toBeNull();
  });

  it('returns the preserved generation (gen_iat) of a renewed token, not its renewal iat', () => {
    expect(callbackTokenIssuedAtMs(jwtWith({ iat: IAT_SECONDS + 86_400, gen_iat: IAT_SECONDS }))).toBe(
      IAT_MS
    );
  });

  it('falls back to iat when gen_iat is malformed', () => {
    expect(callbackTokenIssuedAtMs(jwtWith({ iat: IAT_SECONDS, gen_iat: 'x' }))).toBe(IAT_MS);
    expect(callbackTokenIssuedAtMs(jwtWith({ iat: IAT_SECONDS, gen_iat: -1 }))).toBe(IAT_MS);
    expect(callbackTokenIssuedAtMs(jwtWith({ iat: IAT_SECONDS, gen_iat: 1.5 }))).toBe(IAT_MS);
  });

  it('keeps a renewed token from a superseded Instant generation detectable as stale', async () => {
    // The renewal route signs with the real signer; reading must agree on the claim name.
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const env = {
      JWT_PRIVATE_KEY: await exportPKCS8(privateKey),
      BASE_DOMAIN: 'example.com',
    } as unknown as Env;
    const generationIssuedAtSeconds = Math.floor(Date.now() / 1000) - 2 * 3600;
    const renewed = await signCallbackToken('ws-instant', env, { generationIssuedAtSeconds });
    const firstIssue = await signCallbackToken('ws-instant', env);

    const recoveredAtMs = generationIssuedAtSeconds * 1000 + MARGIN + 60_000;
    const verdict = (token: string) =>
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: iso(recoveredAtMs),
        tokenIssuedAtMs: callbackTokenIssuedAtMs(token),
        marginMs: MARGIN,
      });

    // Renewed after the recovery, but its generation predates it: still superseded.
    expect(callbackTokenIssuedAtMs(renewed)).toBe(generationIssuedAtSeconds * 1000);
    expect(verdict(renewed)).toBe(true);
    // Control: a generation issued after the recovery is current.
    expect(verdict(firstIssue)).toBe(false);
  });
});

describe('getInstantStaleCallbackMarginMs', () => {
  it('defaults when unset', () => {
    expect(getInstantStaleCallbackMarginMs({} as Env)).toBe(DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS);
  });

  it('honours a valid override', () => {
    expect(
      getInstantStaleCallbackMarginMs({ INSTANT_STALE_CALLBACK_MARGIN_MS: '30000' } as unknown as Env)
    ).toBe(30_000);
  });

  it('falls back to default for invalid or negative values', () => {
    expect(
      getInstantStaleCallbackMarginMs({ INSTANT_STALE_CALLBACK_MARGIN_MS: 'abc' } as unknown as Env)
    ).toBe(DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS);
    expect(
      getInstantStaleCallbackMarginMs({ INSTANT_STALE_CALLBACK_MARGIN_MS: '-5' } as unknown as Env)
    ).toBe(DEFAULT_INSTANT_STALE_CALLBACK_MARGIN_MS);
  });
});

describe('isSupersededInstantCallback', () => {
  it('is stale when a cf-container row is reconciled beyond the margin after the token', () => {
    expect(
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: iso(IAT_MS + MARGIN + 1_000),
        tokenIssuedAtMs: IAT_MS,
        marginMs: MARGIN,
      })
    ).toBe(true);
  });

  it('is NOT stale for a non-cf-container runtime even when the row is far newer', () => {
    expect(
      isSupersededInstantCallback({
        runtime: 'vm',
        rowUpdatedAt: iso(IAT_MS + MARGIN + 999_000),
        tokenIssuedAtMs: IAT_MS,
        marginMs: MARGIN,
      })
    ).toBe(false);
  });

  it('is NOT stale within the margin (same generation reconcile gap)', () => {
    expect(
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: iso(IAT_MS + 500),
        tokenIssuedAtMs: IAT_MS,
        marginMs: MARGIN,
      })
    ).toBe(false);
  });

  it('is NOT stale exactly at the boundary (strictly-greater comparison)', () => {
    expect(
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: iso(IAT_MS + MARGIN),
        tokenIssuedAtMs: IAT_MS,
        marginMs: MARGIN,
      })
    ).toBe(false);
  });

  it('fails open (false) when the token iat is unknown', () => {
    expect(
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: iso(IAT_MS + MARGIN + 999_000),
        tokenIssuedAtMs: null,
        marginMs: MARGIN,
      })
    ).toBe(false);
  });

  it('fails open (false) when the row timestamp is missing or unparseable', () => {
    expect(
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: null,
        tokenIssuedAtMs: IAT_MS,
        marginMs: MARGIN,
      })
    ).toBe(false);
    expect(
      isSupersededInstantCallback({
        runtime: 'cf-container',
        rowUpdatedAt: 'not-a-date',
        tokenIssuedAtMs: IAT_MS,
        marginMs: MARGIN,
      })
    ).toBe(false);
  });
});
