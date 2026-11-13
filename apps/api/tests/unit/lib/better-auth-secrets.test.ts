/**
 * BetterAuth secret rotation. Every crypto call here is better-auth's own (`better-auth/crypto`,
 * `better-auth/oauth2`), not a mock, so a library change to the envelope format or to how
 * `secrets`/`secret` are interpreted fails these tests (apps/api/.claude/rules/77).
 */
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { decryptOAuthToken, setTokenUtil } from 'better-auth/oauth2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../../src/auth';
import {
  betterAuthSecretOptions,
  betterAuthSymmetricKey,
} from '../../../src/lib/better-auth-secrets';
import { getBetterAuthSecret } from '../../../src/lib/secrets';
import { __resetPlatformConfigCacheForTest } from '../../../src/services/platform-config';
import { createEnv } from '../../helpers/platform-config-counting-fixture';

// Throwaway test values, long enough that better-auth does not warn about length.
const ENCRYPTION_KEY = 'test-encryption-key-0000000000000000000000000000';
const SECRET_A = 'test-better-auth-secret-A-1111111111111111111111111';
const SECRET_B = 'test-better-auth-secret-B-2222222222222222222222222';
const SECRET_C = 'test-better-auth-secret-C-3333333333333333333333333';
const ACCESS_TOKEN = 'gho_test_access_token_value';

describe('betterAuthSecretOptions: default (unversioned) mode', () => {
  it('returns only { secret } equal to BETTER_AUTH_SECRET when set', () => {
    const env = { ENCRYPTION_KEY, BETTER_AUTH_SECRET: SECRET_A };
    const options = betterAuthSecretOptions(env);
    expect(options).toStrictEqual({ secret: SECRET_A });
    expect(Object.keys(options)).toEqual(['secret']);
    expect(options.secret).toBe(getBetterAuthSecret(env));
  });

  it('returns only { secret } equal to ENCRYPTION_KEY when BETTER_AUTH_SECRET is unset', () => {
    const env = { ENCRYPTION_KEY };
    expect(betterAuthSecretOptions(env)).toStrictEqual({ secret: ENCRYPTION_KEY });
  });

  it('treats empty-string rotation variables as unset', () => {
    const env = {
      ENCRYPTION_KEY,
      BETTER_AUTH_SECRET: SECRET_A,
      BETTER_AUTH_SECRET_VERSION: '',
      BETTER_AUTH_SECRET_PREVIOUS: '',
      BETTER_AUTH_SECRET_PREVIOUS_VERSION: '',
    };
    expect(betterAuthSecretOptions(env)).toStrictEqual({ secret: SECRET_A });
  });

  it('symmetric key is the plain secret string, matching today', () => {
    expect(betterAuthSymmetricKey({ ENCRYPTION_KEY, BETTER_AUTH_SECRET: SECRET_A })).toBe(SECRET_A);
  });
});

describe('betterAuthSecretOptions: first rotation from an unversioned secret', () => {
  const env = {
    ENCRYPTION_KEY,
    BETTER_AUTH_SECRET: SECRET_B,
    BETTER_AUTH_SECRET_VERSION: '1',
    BETTER_AUTH_SECRET_PREVIOUS: SECRET_A,
  };

  it('passes the new secret as secrets[0] and the old one as the legacy secret', () => {
    expect(betterAuthSecretOptions(env)).toStrictEqual({
      secret: SECRET_A,
      secrets: [{ version: 1, value: SECRET_B }],
    });
  });

  it('keeps getBetterAuthSecret equal to secrets[0].value (cookie signing consistency)', () => {
    expect(betterAuthSecretOptions(env).secrets?.[0]?.value).toBe(getBetterAuthSecret(env));
  });

  it('decrypts a bare-hex token written under the old secret', async () => {
    const legacyCiphertext = await symmetricEncrypt({ key: SECRET_A, data: ACCESS_TOKEN });
    expect(legacyCiphertext.startsWith('$ba$')).toBe(false);
    const key = betterAuthSymmetricKey(env);
    await expect(symmetricDecrypt({ key, data: legacyCiphertext })).resolves.toBe(ACCESS_TOKEN);
  });

  it('writes new values as $ba$1$ envelopes that round-trip', async () => {
    const key = betterAuthSymmetricKey(env);
    const envelope = await symmetricEncrypt({ key, data: ACCESS_TOKEN });
    expect(envelope.startsWith('$ba$1$')).toBe(true);
    await expect(symmetricDecrypt({ key, data: envelope })).resolves.toBe(ACCESS_TOKEN);
  });

  it('control: without PREVIOUS the old bare-hex token no longer decrypts', async () => {
    const legacyCiphertext = await symmetricEncrypt({ key: SECRET_A, data: ACCESS_TOKEN });
    const key = betterAuthSymmetricKey({
      ENCRYPTION_KEY,
      BETTER_AUTH_SECRET: SECRET_B,
      BETTER_AUTH_SECRET_VERSION: '1',
    });
    await expect(symmetricDecrypt({ key, data: legacyCiphertext })).rejects.toThrow();
  });
});

describe('betterAuthSecretOptions: second rotation between versions', () => {
  const firstRotation = {
    ENCRYPTION_KEY,
    BETTER_AUTH_SECRET: SECRET_B,
    BETTER_AUTH_SECRET_VERSION: '1',
    BETTER_AUTH_SECRET_PREVIOUS: SECRET_A,
  };
  const secondRotation = {
    ENCRYPTION_KEY,
    BETTER_AUTH_SECRET: SECRET_C,
    BETTER_AUTH_SECRET_VERSION: '2',
    BETTER_AUTH_SECRET_PREVIOUS: SECRET_B,
    BETTER_AUTH_SECRET_PREVIOUS_VERSION: '1',
  };

  it('lists both versions with the current one first; legacy secret is the current secret', () => {
    expect(betterAuthSecretOptions(secondRotation)).toStrictEqual({
      secret: SECRET_C,
      secrets: [
        { version: 2, value: SECRET_C },
        { version: 1, value: SECRET_B },
      ],
    });
    expect(betterAuthSecretOptions(secondRotation).secrets?.[0]?.value).toBe(
      getBetterAuthSecret(secondRotation)
    );
  });

  it('decrypts v1 and v2 envelopes, and writes v2', async () => {
    const v1Envelope = await symmetricEncrypt({
      key: betterAuthSymmetricKey(firstRotation),
      data: 'token-from-v1',
    });
    expect(v1Envelope.startsWith('$ba$1$')).toBe(true);

    const key = betterAuthSymmetricKey(secondRotation);
    const v2Envelope = await symmetricEncrypt({ key, data: 'token-from-v2' });
    expect(v2Envelope.startsWith('$ba$2$')).toBe(true);

    await expect(symmetricDecrypt({ key, data: v1Envelope })).resolves.toBe('token-from-v1');
    await expect(symmetricDecrypt({ key, data: v2Envelope })).resolves.toBe('token-from-v2');
  });

  it('accepts PREVIOUS_VERSION equal to VERSION when the values are identical (no-op)', () => {
    expect(
      betterAuthSecretOptions({
        ENCRYPTION_KEY,
        BETTER_AUTH_SECRET: SECRET_B,
        BETTER_AUTH_SECRET_VERSION: '1',
        BETTER_AUTH_SECRET_PREVIOUS: SECRET_B,
        BETTER_AUTH_SECRET_PREVIOUS_VERSION: '1',
      })
    ).toStrictEqual({ secret: SECRET_B, secrets: [{ version: 1, value: SECRET_B }] });
  });
});

describe('betterAuthSecretOptions: invalid configuration fails closed', () => {
  it.each(['0', '-1', '1.5', 'abc', '01', ' ', '1e3', '9007199254740993'])(
    'throws on BETTER_AUTH_SECRET_VERSION=%j',
    (version) => {
      expect(() =>
        betterAuthSecretOptions({
          ENCRYPTION_KEY,
          BETTER_AUTH_SECRET: SECRET_B,
          BETTER_AUTH_SECRET_VERSION: version,
        })
      ).toThrow(/BETTER_AUTH_SECRET_VERSION/);
    }
  );

  it('throws on an invalid BETTER_AUTH_SECRET_PREVIOUS_VERSION', () => {
    expect(() =>
      betterAuthSecretOptions({
        ENCRYPTION_KEY,
        BETTER_AUTH_SECRET: SECRET_C,
        BETTER_AUTH_SECRET_VERSION: '2',
        BETTER_AUTH_SECRET_PREVIOUS: SECRET_B,
        BETTER_AUTH_SECRET_PREVIOUS_VERSION: 'one',
      })
    ).toThrow(/BETTER_AUTH_SECRET_PREVIOUS_VERSION/);
  });

  it('throws when PREVIOUS is set without VERSION (the old secret would be ignored)', () => {
    expect(() =>
      betterAuthSecretOptions({
        ENCRYPTION_KEY,
        BETTER_AUTH_SECRET: SECRET_B,
        BETTER_AUTH_SECRET_PREVIOUS: SECRET_A,
      })
    ).toThrow(/require BETTER_AUTH_SECRET_VERSION/);
  });

  it('throws when PREVIOUS_VERSION is set without PREVIOUS', () => {
    expect(() =>
      betterAuthSecretOptions({
        ENCRYPTION_KEY,
        BETTER_AUTH_SECRET: SECRET_C,
        BETTER_AUTH_SECRET_VERSION: '2',
        BETTER_AUTH_SECRET_PREVIOUS_VERSION: '1',
      })
    ).toThrow(/BETTER_AUTH_SECRET_PREVIOUS is not/);
  });

  it('throws when PREVIOUS_VERSION reuses VERSION with a different value', () => {
    expect(() =>
      betterAuthSecretOptions({
        ENCRYPTION_KEY,
        BETTER_AUTH_SECRET: SECRET_C,
        BETTER_AUTH_SECRET_VERSION: '1',
        BETTER_AUTH_SECRET_PREVIOUS: SECRET_B,
        BETTER_AUTH_SECRET_PREVIOUS_VERSION: '1',
      })
    ).toThrow(/new version number/);
  });

  it('the error message never contains a secret value', () => {
    try {
      betterAuthSecretOptions({
        ENCRYPTION_KEY,
        BETTER_AUTH_SECRET: SECRET_B,
        BETTER_AUTH_SECRET_VERSION: 'x',
        BETTER_AUTH_SECRET_PREVIOUS: SECRET_A,
      });
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(SECRET_A);
      expect(message).not.toContain(SECRET_B);
    }
  });
});

describe('createAuth builds the real better-auth context from the env', () => {
  beforeEach(() => __resetPlatformConfigCacheForTest());
  afterEach(() => __resetPlatformConfigCacheForTest());

  it('unversioned env: ctx.secret and ctx.secretConfig are the plain secret', async () => {
    const { env } = createEnv({ ENCRYPTION_KEY, BETTER_AUTH_SECRET: SECRET_A });
    const ctx = await (await createAuth(env)).$context;
    expect(ctx.secret).toBe(SECRET_A);
    expect(ctx.secretConfig).toBe(SECRET_A);
    expect(ctx.options.secrets).toBeUndefined();
  });

  it('versioned env: cookie secret matches getBetterAuthSecret and stored tokens survive', async () => {
    // A token stored by the pre-rotation install (legacy bare hex under SECRET_A), produced by
    // better-auth's own token writer with the pre-rotation context.
    const { env: oldEnv } = createEnv({ ENCRYPTION_KEY, BETTER_AUTH_SECRET: SECRET_A });
    const oldCtx = await (await createAuth(oldEnv)).$context;
    const storedToken = await setTokenUtil(ACCESS_TOKEN, oldCtx);
    expect(storedToken).toMatch(/^[0-9a-f]+$/);

    __resetPlatformConfigCacheForTest();
    const { env } = createEnv({
      ENCRYPTION_KEY,
      BETTER_AUTH_SECRET: SECRET_B,
      BETTER_AUTH_SECRET_VERSION: '1',
      BETTER_AUTH_SECRET_PREVIOUS: SECRET_A,
    });
    const ctx = await (await createAuth(env)).$context;

    // Session cookies (and services/session-factory.ts) sign with getBetterAuthSecret(env).
    expect(ctx.secret).toBe(getBetterAuthSecret(env));
    expect(ctx.secret).toBe(SECRET_B);
    expect(ctx.secretConfig).toEqual(betterAuthSymmetricKey(env));

    await expect(decryptOAuthToken(storedToken as string, ctx)).resolves.toBe(ACCESS_TOKEN);
    const rewritten = await setTokenUtil(ACCESS_TOKEN, ctx);
    expect(rewritten).toMatch(/^\$ba\$1\$/);
    await expect(decryptOAuthToken(rewritten as string, ctx)).resolves.toBe(ACCESS_TOKEN);
  });
});
