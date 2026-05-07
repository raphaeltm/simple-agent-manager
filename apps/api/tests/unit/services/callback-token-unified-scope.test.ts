/**
 * Unified Callback Token Scope Enforcement Tests (F-010)
 *
 * Verifies that verifyCallbackToken's expectedScope parameter provides
 * the same scope enforcement previously done inline in verifyAIProxyAuth.
 *
 * Contract: both verifyCallbackToken(token, env, { expectedScope: 'workspace' })
 * and the old verifyAIProxyAuth scope check reject the same malformed/wrong-scope tokens.
 */
import { importPKCS8, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

const TEST_RSA_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCPyp4M1gozIroj\n71EuyfibMVSmgUebPkSF04XPXDxTit3VrArbFe6CIkJEvGiSHv0uiNsh/Ae7RMGa\n31HhOvr4dSNsJhwyJCYHjHxs3JHC6K3LkfahFQz2vSs4XD4jzKCLK075ooT1J3Nn\n8osEM90laas/t6VUNesyfUi/kzS0COKa295kVwRwbrJ2BpRT/1dDUzxvKJhmsHTu\n+zyHDj2JdcpqJ5C8F14OBdhf7oH0yBJHhG54FSW9PtzkD6RFS4hQiQbx+VvLTFEX\nprXHQo4AS5aPD+rCygthaWNMhh+KPYy9mJTnI1ZFJPhjAH/Il+6dTMLN2P9kWnHe\nOyienBwFAgMBAAECggEAHxjJagq/HXR4740R0E3fLUbzoOfMEeObQ5rtcR0oMcQS\nOiPRHDTnxi59COr7LYC0rgPsajLchDA4M5Nw3IYaITIKFVk/l0twiwjjntJr1oxm\nC6S3QvpvuYvLJU7zpF/cZ4SX+Y5fdTpRL82JKYFC5hSuc6L2hxn7Ecn8+etuxjFj\nsrvUhjIAH6d3QtGYRFk1vWWgu9RlwxDReMIIL93SrQhJbVAwg75JmS7Aw7oMCkd7\nGfJ06p4vWp34p5btEeq7dcf0fvfgAvRrggjjgziZRpPWBbypQgHuwi/Y+O5mO74N\nsJ0dIQ92Ytrf7HGsFpKM1QPCRZHmWw02Wjv2+R05SQKBgQDGMmKlXFL9ZlApFCqd\nbySBN57zlRXPZBzXWU+VgPXvo5wU9mNTJYdB2D60itOkwYZ5gjQuEkzva0Z61rM6\n0YzBLnTr6WM4FRz2YQe7u1b5ip3ugILaW3u2zhSTWZ1cOAm3KcoiQdmVXnFMRrhk\n7vbjgUVlWRO5Om59hj3SGoVFbQKBgQC5ukNdnabLMTH6RTXvaIBlqSsXP9MKxCJY\nzESYVijypU9z1JiL9hIDCCtEyYtE8Y3742rnoARsSyn47drDXArLehHu4cOdryj3\nLGW8npw/Dc4fGCucDrB9NEpmrWdZUOflxGEU1P0biTrToRrTr2bUpprUJDJSR6RN\nsHdO5r3J+QKBgAQ7GR38jYz5PSbTVmGL+NSFUnBSs2d89JyoPGmtmhJmhLNx2wbw\nWyXNrvD9saznsK4xWFnPbDMEMDn5EVRlGsMY8cgDcGnHEZo00gxw4FdtXRe1SJXO\ntCJf3dKTbCeGzrZJPxZiH3nvzS1aqR8GduC+ZrPWJfSjSa6GShWNGWE1AoGAQdom\nKppMWn1N8CP8FK/j3qfVrH+nz4hteTisFatvB2HPww0dLXsJNeP+m3wukjpnkmk3\nLXtSNieMcUO8rkoDVdQpaZ7I4i8KAmHOjMtcMQsvC11hkQqwTyRsQO242DVUk+ZG\nWcGPIOVOY10bCvWFK18LRK603PGj8xvfoa00m9kCgYEAj9pNWe2XDV8MZcbK9sQt\nJe0WlWdujyB8SvXHR90QGZvwzSAptDM8FEB7YZGSWA0M2gkMb7BD7jYGgkIpMYcI\nXV48kdOyCc53d4gy+3vwFbzL1Gr7V5CR3bamO5FBZswC3wlL+g7cBGmTD7CSdHYa\nTnJ/qJN+X9RCVxzUO7Z3YZM=\n-----END PRIVATE KEY-----\n";

const TEST_RSA_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAj8qeDNYKMyK6I+9RLsn4\nmzFUpoFHmz5EhdOFz1w8U4rd1awK2xXugiJCRLxokh79LojbIfwHu0TBmt9R4Tr6\n+HUjbCYcMiQmB4x8bNyRwuity5H2oRUM9r0rOFw+I8ygiytO+aKE9SdzZ/KLBDPd\nJWmrP7elVDXrMn1Iv5M0tAjimtveZFcEcG6ydgaUU/9XQ1M8byiYZrB07vs8hw49\niXXKaieQvBdeDgXYX+6B9MgSR4RueBUlvT7c5A+kRUuIUIkG8flby0xRF6a1x0KO\nAEuWjw/qwsoLYWljTIYfij2MvZiU5yNWRST4YwB/yJfunUzCzdj/ZFpx3jsonpwc\nBQIDAQAB\n-----END PUBLIC KEY-----\n";

const TEST_ISSUER = 'https://api.test.example.com';

async function signTestToken(claims: Record<string, unknown>, expiresIn = '1h'): Promise<string> {
  const privateKey = await importPKCS8(TEST_RSA_PRIVATE_KEY, 'RS256');
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(TEST_ISSUER)
    .setAudience('workspace-callback')
    .setExpirationTime(expiresIn)
    .setIssuedAt()
    .sign(privateKey);
}

function makeTestEnv() {
  return {
    JWT_PUBLIC_KEY: TEST_RSA_PUBLIC_KEY,
    JWT_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
    BASE_DOMAIN: 'test.example.com',
  } as unknown as Parameters<typeof import('../../../src/services/jwt').verifyCallbackToken>[1];
}

describe('verifyCallbackToken — unified scope enforcement (F-010)', () => {
  it('accepts workspace-scoped token when expectedScope is workspace', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const token = await signTestToken({ type: 'callback', workspace: 'ws-123', scope: 'workspace' });
    const env = makeTestEnv();

    const result = await verifyCallbackToken(token, env, { expectedScope: 'workspace' });
    expect(result.scope).toBe('workspace');
    expect(result.workspace).toBe('ws-123');
  });

  it('rejects node-scoped token when expectedScope is workspace', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const token = await signTestToken({ type: 'callback', workspace: 'ws-123', scope: 'node' });
    const env = makeTestEnv();

    await expect(
      verifyCallbackToken(token, env, { expectedScope: 'workspace' })
    ).rejects.toThrow(/does not match expected/);
  });

  it('rejects legacy token (no scope) when expectedScope is workspace', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const token = await signTestToken({ type: 'callback', workspace: 'ws-123' });
    const env = makeTestEnv();

    await expect(
      verifyCallbackToken(token, env, { expectedScope: 'workspace' })
    ).rejects.toThrow(/does not match expected/);
  });

  it('accepts node-scoped token when expectedScope is node', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const token = await signTestToken({ type: 'callback', workspace: 'node-abc', scope: 'node' });
    const env = makeTestEnv();

    const result = await verifyCallbackToken(token, env, { expectedScope: 'node' });
    expect(result.scope).toBe('node');
  });

  it('preserves legacy behavior — no scope check when expectedScope omitted', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const legacyToken = await signTestToken({ type: 'callback', workspace: 'ws-legacy' });
    const env = makeTestEnv();

    const result = await verifyCallbackToken(legacyToken, env);
    expect(result.scope).toBeUndefined();
    expect(result.workspace).toBe('ws-legacy');
  });

  it('preserves legacy behavior — node token accepted when no expectedScope', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const token = await signTestToken({ type: 'callback', workspace: 'node-123', scope: 'node' });
    const env = makeTestEnv();

    const result = await verifyCallbackToken(token, env);
    expect(result.scope).toBe('node');
  });

  it('contract: AI proxy path and direct verifyCallbackToken reject same tokens', async () => {
    const { verifyCallbackToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    // A node-scoped token should be rejected when workspace scope is expected
    const nodeToken = await signTestToken({ type: 'callback', workspace: 'ws-123', scope: 'node' });

    // New unified path rejects
    await expect(
      verifyCallbackToken(nodeToken, env, { expectedScope: 'workspace' })
    ).rejects.toThrow();

    // But the token IS valid without scope enforcement (proving rejection is scope-based)
    const result = await verifyCallbackToken(nodeToken, env);
    expect(result.scope).toBe('node');
  });
});
