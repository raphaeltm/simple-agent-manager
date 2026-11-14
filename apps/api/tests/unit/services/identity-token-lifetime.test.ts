import { DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS } from '@simple-agent-manager/shared';
import { decodeJwt, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { signIdentityToken } from '../../../src/services/jwt';

let env: Env;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  env = {
    BASE_DOMAIN: 'example.test',
    JWT_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
  } as Env;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('cloud federation identity token lifetime', () => {
  it.each([
    {
      configured: undefined,
      override: undefined,
      expected: DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS,
    },
    { configured: '180', override: undefined, expected: 180 },
    { configured: '180', override: 60, expected: 60 },
  ])(
    'keeps the exact lifetime across a clock boundary: %j',
    async ({ configured, override, expected }) => {
      const beforeBoundary = new Date('2026-11-14T00:00:00.999Z');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(beforeBoundary);
      const setExpirationTime = SignJWT.prototype.setExpirationTime;
      vi.spyOn(SignJWT.prototype, 'setExpirationTime').mockImplementation(function (value) {
        const result = setExpirationTime.call(this, value);
        vi.setSystemTime(new Date(beforeBoundary.getTime() + 2));
        return result;
      });

      const token = await signIdentityToken(
        { userId: 'user', projectId: 'project', audience: 'external-service' },
        { ...env, GCP_IDENTITY_TOKEN_EXPIRY_SECONDS: configured },
        override
      );
      const payload = decodeJwt(token);
      expect(payload.iat).toBe(Math.floor(beforeBoundary.getTime() / 1000));
      expect(payload.exp! - payload.iat!).toBe(expected);
    }
  );
});
