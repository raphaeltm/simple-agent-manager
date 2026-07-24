/**
 * Credential-setup terminal token tests.
 *
 * Covers signCredentialSetupTerminalToken / verifyCredentialSetupTerminalToken
 * (apps/api/src/services/jwt.ts), the JWT that authenticates the browser's
 * WebSocket connection to the ephemeral Codex guided-setup Sandbox terminal
 * (see apps/api/src/routes/agent-credential-setup-sessions.ts:GET /:id/terminal/ws).
 *
 * Mirrors the established pattern in port-access-token.test.ts /
 * local-forward-token.test.ts: plain node-env unit tests (no Miniflare), a
 * fixed test-only RSA keypair, and a `makeTestEnv` helper.
 */
import { importPKCS8, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';

const TEST_RSA_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCPyp4M1gozIroj\n71EuyfibMVSmgUebPkSF04XPXDxTit3VrArbFe6CIkJEvGiSHv0uiNsh/Ae7RMGa\n31HhOvr4dSNsJhwyJCYHjHxs3JHC6K3LkfahFQz2vSs4XD4jzKCLK075ooT1J3Nn\n8osEM90laas/t6VUNesyfUi/kzS0COKa295kVwRwbrJ2BpRT/1dDUzxvKJhmsHTu\n+zyHDj2JdcpqJ5C8F14OBdhf7oH0yBJHhG54FSW9PtzkD6RFS4hQiQbx+VvLTFEX\nprXHQo4AS5aPD+rCygthaWNMhh+KPYy9mJTnI1ZFJPhjAH/Il+6dTMLN2P9kWnHe\nOyienBwFAgMBAAECggEAHxjJagq/HXR4740R0E3fLUbzoOfMEeObQ5rtcR0oMcQS\nOiPRHDTnxi59COr7LYC0rgPsajLchDA4M5Nw3IYaITIKFVk/l0twiwjjntJr1oxm\nC6S3QvpvuYvLJU7zpF/cZ4SX+Y5fdTpRL82JKYFC5hSuc6L2hxn7Ecn8+etuxjFj\nsrvUhjIAH6d3QtGYRFk1vWWgu9RlwxDReMIIL93SrQhJbVAwg75JmS7Aw7oMCkd7\nGfJ06p4vWp34p5btEeq7dcf0fvfgAvRrggjjgziZRpPWBbypQgHuwi/Y+O5mO74N\nsJ0dIQ92Ytrf7HGsFpKM1QPCRZHmWw02Wjv2+R05SQKBgQDGMmKlXFL9ZlApFCqd\nbySBN57zlRXPZBzXWU+VgPXvo5wU9mNTJYdB2D60itOkwYZ5gjQuEkzva0Z61rM6\n0YzBLnTr6WM4FRz2YQe7u1b5ip3ugILaW3u2zhSTWZ1cOAm3KcoiQdmVXnFMRrhk\n7vbjgUVlWRO5Om59hj3SGoVFbQKBgQC5ukNdnabLMTH6RTXvaIBlqSsXP9MKxCJY\nzESYVijypU9z1JiL9hIDCCtEyYtE8Y3742rnoARsSyn47drDXArLehHu4cOdryj3\nLGW8npw/Dc4fGCucDrB9NEpmrWdZUOflxGEU1P0biTrToRrTr2bUpprUJDJSR6RN\nsHdO5r3J+QKBgAQ7GR38jYz5PSbTVmGL+NSFUnBSs2d89JyoPGmtmhJmhLNx2wbw\nWyXNrvD9saznsK4xWFnPbDMEMDn5EVRlGsMY8cgDcGnHEZo00gxw4FdtXRe1SJXO\ntCJf3dKTbCeGzrZJPxZiH3nvzS1aqR8GduC+ZrPWJfSjSa6GShWNGWE1AoGAQdom\nKppMWn1N8CP8FK/j3qfVrH+nz4hteTisFatvB2HPww0dLXsJNeP+m3wukjpnkmk3\nLXtSNieMcUO8rkoDVdQpaZ7I4i8KAmHOjMtcMQsvC11hkQqwTyRsQO242DVUk+ZG\nWcGPIOVOY10bCvWFK18LRK603PGj8xvfoa00m9kCgYEAj9pNWe2XDV8MZcbK9sQt\nJe0WlWdujyB8SvXHR90QGZvwzSAptDM8FEB7YZGSWA0M2gkMb7BD7jYGgkIpMYcI\nXV48kdOyCc53d4gy+3vwFbzL1Gr7V5CR3bamO5FBZswC3wlL+g7cBGmTD7CSdHYa\nTnJ/qJN+X9RCVxzUO7Z3YZM=\n-----END PRIVATE KEY-----\n';

const TEST_RSA_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAj8qeDNYKMyK6I+9RLsn4\nmzFUpoFHmz5EhdOFz1w8U4rd1awK2xXugiJCRLxokh79LojbIfwHu0TBmt9R4Tr6\n+HUjbCYcMiQmB4x8bNyRwuity5H2oRUM9r0rOFw+I8ygiytO+aKE9SdzZ/KLBDPd\nJWmrP7elVDXrMn1Iv5M0tAjimtveZFcEcG6ydgaUU/9XQ1M8byiYZrB07vs8hw49\niXXKaieQvBdeDgXYX+6B9MgSR4RueBUlvT7c5A+kRUuIUIkG8flby0xRF6a1x0KO\nAEuWjw/qwsoLYWljTIYfij2MvZiU5yNWRST4YwB/yJfunUzCzdj/ZFpx3jsonpwc\nBQIDAQAB\n-----END PUBLIC KEY-----\n';

// A second, unrelated keypair — used to prove signature verification actually
// checks the key, not just the token shape (rule 45/28-adjacent: tampered
// credential-bearing tokens must be rejected, not merely "differently shaped").
const OTHER_RSA_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCV93x2EyxEBk7u\npFMTLatfONe6gGOnr6XV2z9FsfAN+8nVtHNykTXb+MxUPR7rn8im7CIQLkjQRRca\nieyya6tpusK5x08Qo4L/SzXW+XsKjf81k9cBwm84N3VVKSzbexUtz4uJWKWi+1sC\nFKWoCR+DWgWvhPw3jg/rt32N/hTKbMjEbMx224VmV+Dka2qVFLiqKW46o9astLcq\ngX/orE/y9wivDPzMQTM3IfRUwJHlJu0WIb70oLyptbXXAOBmGFJMdbEvpWItRODf\ndiJ3Pw9ngW97Er4AIfT2Wx0KnUchG8BFA2nfgrxI8M396nM8uSs8ezDaoCgYoktm\nCcuIIOb1AgMBAAECggEACmF5v5CfMUxAfXtpdrvkD3DXWgUWIN7jO1T0YcYp6EXk\nGENn9GfB0yq7Nh+O+t9yG7/fscAKcUQ/D6q5dDZIxMZVQVffDLdM05Aot2tIjZf7\nsQE9UlVbrogEOrNhdAXmlue1cHnu6UO97nxwZRvQjx6Voysw7EWMq5PlgIU0ejiH\nYjE52VQNadxQhZ8DqphOahcOt20deZ41cwN1bKlY4DnLuahVfkIZ9tA66+IY5ob2\nTuAl1plxQfadUNkVOusMbLjjv4ol/aqxccyhxr3IA/kM3UYiFxNohKIEJFsUuzGt\nWZxdIquRaH+FQtnhCUypkURcdzLrUisTQVgjVm97lwKBgQDGxjDwUkaefCMbv3FH\nAyVIaA8oMXRpERawEHmcS+egzfkdC4yC50Eh4fgYuSihnIKMYuJ4kJInarmfeZFD\n8EZdMqHckSNpxQcgYCII42gaXh/BjjZ+lQYmDKXyApTyfHwP/vZ/nkZjaJrEEWIg\nf4i+iN3B7KtIlZ1LuRF99d6BfwKBgQDBJCY+lYGIUBui+p+bbHdv5bK7uVg7xBim\nHLdr+LUioHQeSc0Z5mCjGWRV40KSCWP4iZNCvLHKPX8a0z3kEkKErLpwLPlZSB8a\ngWmC4p1FIFhn2P8od6LtaWGbMg+palXm/uDw990depEF3j9dMmnoQvt9rtEJxhgF\nNeDCzYzpiwKBgQDCfp7YJ8lNve2kcvhmIZ/Tb26VR36+Z6gpcpVr56GnaKM+VlSQ\nqbLDcpYNqu8k4z2iHAe5LMy1oOosLwmCzpIrEyXp6mIaVl2YwjfLNqhgVIUCISMV\nTMANbwbY/Mm9Uy0ZgcK0MKxzDKGTA+deISwuM0G5RNh8V1joBRgmhfPIBQKBgHnE\nNrBiRaYRCzt3UsUEX1CWulaMBcq4WOnxVNqnlFteWZb25G4dxnNNgOp9Ou0jKnn5\nEnSSzmw41TeuUmjF8lX/KBOs5w+Y3rMxP7oa8Rgxykq+ji+PLZMMS1My/pjKx5m4\nu0xwmGELcv8GHWC+dfLOuAuG+Zd14pL2YtuuB9b9AoGAIeYQNLMHNyEK/Kh4Vsza\n9rzbR0oXLqIe3PJOKqxpA4gSBdXbsizc7bkhhTHPDTpUo30Pke5f03O/RoawLT63\nr3SA1x5MVCsiVcqybvqtMIyy1zc/oKSUyuYh44Sjpii7Q9DJlCeMupyA3TSVb0Qa\nO+hP/5ZHDz4epkJVLKvwE2Y=\n-----END PRIVATE KEY-----';

function makeTestEnv(overrides?: Partial<Env>): Env {
  return {
    JWT_PUBLIC_KEY: TEST_RSA_PUBLIC_KEY,
    JWT_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
    BASE_DOMAIN: 'test.example.com',
    ...overrides,
  } as unknown as Env;
}

describe('credential-setup terminal token — sign/verify round trip', () => {
  it('round-trips {userId, setupSessionId}', async () => {
    const { signCredentialSetupTerminalToken, verifyCredentialSetupTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);
    const payload = await verifyCredentialSetupTerminalToken(token, env);

    expect(payload).toEqual({ userId: 'user-1', setupSessionId: 'setup-abc' });
  });

  it('returns an ISO expiresAt consistent with the default 5-minute expiry', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();
    const before = Date.now();
    const { expiresAt } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);
    const deltaMs = new Date(expiresAt).getTime() - before;

    // Default DEFAULT_CREDENTIAL_SETUP_TERMINAL_TOKEN expiry is 5 minutes (300000ms).
    expect(deltaMs).toBeGreaterThan(4 * 60_000);
    expect(deltaMs).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it('uses a configurable expiry from CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const { decodeJwt } = await import('jose');
    const env = makeTestEnv({ CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS: '30000' });

    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);
    const claims = decodeJwt(token);
    const lifetime = (claims.exp as number) - (claims.iat as number);

    expect(lifetime).toBe(30); // 30 seconds
  });

  it('ignores an invalid (non-positive) expiry override and falls back to the default', async () => {
    const { signCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const { decodeJwt } = await import('jose');
    const env = makeTestEnv({ CREDENTIAL_SETUP_TERMINAL_TOKEN_EXPIRY_MS: '-5' });

    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);
    const claims = decodeJwt(token);
    const lifetime = (claims.exp as number) - (claims.iat as number);

    expect(lifetime).toBe(5 * 60); // falls back to the 5-minute default
  });
});

describe('credential-setup terminal token — rejects malformed/tampered tokens', () => {
  it('rejects a garbage string', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    await expect(verifyCredentialSetupTerminalToken('not-a-jwt-at-all', env)).rejects.toThrow();
  });

  it('rejects an empty string', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    await expect(verifyCredentialSetupTerminalToken('', env)).rejects.toThrow();
  });

  it('rejects a token signed with a different (attacker-controlled) private key', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv(); // verifies against TEST_RSA_PUBLIC_KEY

    const otherPrivateKey = await importPKCS8(OTHER_RSA_PRIVATE_KEY, 'RS256');
    const forgedToken = await new SignJWT({ setupSession: 'setup-victim' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.test.example.com')
      .setSubject('attacker')
      .setAudience('credential-setup-terminal')
      .setExpirationTime(new Date(Date.now() + 60_000))
      .setIssuedAt()
      .sign(otherPrivateKey);

    await expect(verifyCredentialSetupTerminalToken(forgedToken, env)).rejects.toThrow();
  });

  it('rejects a structurally tampered token (flipped signature byte)', async () => {
    const { signCredentialSetupTerminalToken, verifyCredentialSetupTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);

    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    // Flip a MIDDLE character of the signature (all 6 bits significant). The
    // final base64url char's low bits are zero-padding, so flipping it can decode
    // to a byte-identical signature that still verifies (a flaky false pass).
    // Rotating a middle char one position in the alphabet guarantees the decoded
    // signature bytes actually change.
    const sig = parts[2]!;
    const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const mid = Math.floor(sig.length / 2);
    const replacement = B64URL[(B64URL.indexOf(sig[mid]!) + 1) % B64URL.length]!;
    const tamperedToken = `${parts[0]}.${parts[1]}.${sig.slice(0, mid)}${replacement}${sig.slice(mid + 1)}`;

    await expect(verifyCredentialSetupTerminalToken(tamperedToken, env)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    const privateKey = await importPKCS8(TEST_RSA_PRIVATE_KEY, 'RS256');
    const expiredToken = await new SignJWT({ setupSession: 'setup-abc' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.test.example.com')
      .setSubject('user-1')
      .setAudience('credential-setup-terminal')
      .setExpirationTime(new Date(Date.now() - 1000)) // expired 1 second ago
      .setIssuedAt(new Date(Date.now() - 60_000))
      .sign(privateKey);

    await expect(verifyCredentialSetupTerminalToken(expiredToken, env)).rejects.toThrow();
  });

  it('rejects a token missing the setupSession claim', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    const privateKey = await importPKCS8(TEST_RSA_PRIVATE_KEY, 'RS256');
    const tokenWithoutSetupSession = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.test.example.com')
      .setSubject('user-1')
      .setAudience('credential-setup-terminal')
      .setExpirationTime(new Date(Date.now() + 60_000))
      .setIssuedAt()
      .sign(privateKey);

    await expect(verifyCredentialSetupTerminalToken(tokenWithoutSetupSession, env)).rejects.toThrow(
      'Missing setupSession claim'
    );
  });

  it('rejects a token missing the subject (userId) claim', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    const privateKey = await importPKCS8(TEST_RSA_PRIVATE_KEY, 'RS256');
    const tokenWithoutSubject = await new SignJWT({ setupSession: 'setup-abc' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.test.example.com')
      // no .setSubject(...)
      .setAudience('credential-setup-terminal')
      .setExpirationTime(new Date(Date.now() + 60_000))
      .setIssuedAt()
      .sign(privateKey);

    await expect(verifyCredentialSetupTerminalToken(tokenWithoutSubject, env)).rejects.toThrow(
      'Missing subject claim'
    );
  });

  it('rejects a token issued for a different issuer (BASE_DOMAIN mismatch)', async () => {
    const { verifyCredentialSetupTerminalToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    const privateKey = await importPKCS8(TEST_RSA_PRIVATE_KEY, 'RS256');
    const wrongIssuerToken = await new SignJWT({ setupSession: 'setup-abc' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.attacker.example.com')
      .setSubject('user-1')
      .setAudience('credential-setup-terminal')
      .setExpirationTime(new Date(Date.now() + 60_000))
      .setIssuedAt()
      .sign(privateKey);

    await expect(verifyCredentialSetupTerminalToken(wrongIssuerToken, env)).rejects.toThrow();
  });
});

describe('credential-setup terminal token — audience isolation', () => {
  it('is rejected by verifyPortAccessToken (wrong audience)', async () => {
    const { signCredentialSetupTerminalToken, verifyPortAccessToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);

    await expect(verifyPortAccessToken(token, env)).rejects.toThrow();
  });

  it('is rejected by verifyTerminalToken (wrong audience)', async () => {
    const { signCredentialSetupTerminalToken, verifyTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);

    await expect(verifyTerminalToken(token, env)).rejects.toThrow();
  });

  it('is rejected by verifyCallbackToken (wrong audience)', async () => {
    const { signCredentialSetupTerminalToken, verifyCallbackToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signCredentialSetupTerminalToken('user-1', 'setup-abc', env);

    await expect(verifyCallbackToken(token, env)).rejects.toThrow();
  });

  it('rejects a port-access token (different audience)', async () => {
    const { signPortAccessToken, verifyCredentialSetupTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signPortAccessToken('user-1', 'ws-abc', 3000, env);

    await expect(verifyCredentialSetupTerminalToken(token, env)).rejects.toThrow();
  });

  it('rejects a workspace terminal token (different audience)', async () => {
    const { signTerminalToken, verifyCredentialSetupTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signTerminalToken('user-1', 'ws-abc', env);

    await expect(verifyCredentialSetupTerminalToken(token, env)).rejects.toThrow();
  });

  it('rejects a node-scoped callback token (different audience)', async () => {
    const { signNodeCallbackToken, verifyCredentialSetupTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signNodeCallbackToken('node-1', env);

    await expect(verifyCredentialSetupTerminalToken(token, env)).rejects.toThrow();
  });
});
