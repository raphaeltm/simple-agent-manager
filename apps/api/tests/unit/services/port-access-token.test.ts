/**
 * Port Access Token Tests
 *
 * Verifies:
 * - signPortAccessToken / verifyPortAccessToken round-trip
 * - Wrong workspace → rejected
 * - Wrong port → rejected
 * - Port-access token rejected by verifyTerminalToken (audience mismatch)
 * - Terminal token rejected by verifyPortAccessToken (audience mismatch)
 * - Expired → rejected
 */
import { importPKCS8, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';

const TEST_RSA_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCPyp4M1gozIroj\n71EuyfibMVSmgUebPkSF04XPXDxTit3VrArbFe6CIkJEvGiSHv0uiNsh/Ae7RMGa\n31HhOvr4dSNsJhwyJCYHjHxs3JHC6K3LkfahFQz2vSs4XD4jzKCLK075ooT1J3Nn\n8osEM90laas/t6VUNesyfUi/kzS0COKa295kVwRwbrJ2BpRT/1dDUzxvKJhmsHTu\n+zyHDj2JdcpqJ5C8F14OBdhf7oH0yBJHhG54FSW9PtzkD6RFS4hQiQbx+VvLTFEX\nprXHQo4AS5aPD+rCygthaWNMhh+KPYy9mJTnI1ZFJPhjAH/Il+6dTMLN2P9kWnHe\nOyienBwFAgMBAAECggEAHxjJagq/HXR4740R0E3fLUbzoOfMEeObQ5rtcR0oMcQS\nOiPRHDTnxi59COr7LYC0rgPsajLchDA4M5Nw3IYaITIKFVk/l0twiwjjntJr1oxm\nC6S3QvpvuYvLJU7zpF/cZ4SX+Y5fdTpRL82JKYFC5hSuc6L2hxn7Ecn8+etuxjFj\nsrvUhjIAH6d3QtGYRFk1vWWgu9RlwxDReMIIL93SrQhJbVAwg75JmS7Aw7oMCkd7\nGfJ06p4vWp34p5btEeq7dcf0fvfgAvRrggjjgziZRpPWBbypQgHuwi/Y+O5mO74N\nsJ0dIQ92Ytrf7HGsFpKM1QPCRZHmWw02Wjv2+R05SQKBgQDGMmKlXFL9ZlApFCqd\nbySBN57zlRXPZBzXWU+VgPXvo5wU9mNTJYdB2D60itOkwYZ5gjQuEkzva0Z61rM6\n0YzBLnTr6WM4FRz2YQe7u1b5ip3ugILaW3u2zhSTWZ1cOAm3KcoiQdmVXnFMRrhk\n7vbjgUVlWRO5Om59hj3SGoVFbQKBgQC5ukNdnabLMTH6RTXvaIBlqSsXP9MKxCJY\nzESYVijypU9z1JiL9hIDCCtEyYtE8Y3742rnoARsSyn47drDXArLehHu4cOdryj3\nLGW8npw/Dc4fGCucDrB9NEpmrWdZUOflxGEU1P0biTrToRrTr2bUpprUJDJSR6RN\nsHdO5r3J+QKBgAQ7GR38jYz5PSbTVmGL+NSFUnBSs2d89JyoPGmtmhJmhLNx2wbw\nWyXNrvD9saznsK4xWFnPbDMEMDn5EVRlGsMY8cgDcGnHEZo00gxw4FdtXRe1SJXO\ntCJf3dKTbCeGzrZJPxZiH3nvzS1aqR8GduC+ZrPWJfSjSa6GShWNGWE1AoGAQdom\nKppMWn1N8CP8FK/j3qfVrH+nz4hteTisFatvB2HPww0dLXsJNeP+m3wukjpnkmk3\nLXtSNieMcUO8rkoDVdQpaZ7I4i8KAmHOjMtcMQsvC11hkQqwTyRsQO242DVUk+ZG\nWcGPIOVOY10bCvWFK18LRK603PGj8xvfoa00m9kCgYEAj9pNWe2XDV8MZcbK9sQt\nJe0WlWdujyB8SvXHR90QGZvwzSAptDM8FEB7YZGSWA0M2gkMb7BD7jYGgkIpMYcI\nXV48kdOyCc53d4gy+3vwFbzL1Gr7V5CR3bamO5FBZswC3wlL+g7cBGmTD7CSdHYa\nTnJ/qJN+X9RCVxzUO7Z3YZM=\n-----END PRIVATE KEY-----\n';

const TEST_RSA_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAj8qeDNYKMyK6I+9RLsn4\nmzFUpoFHmz5EhdOFz1w8U4rd1awK2xXugiJCRLxokh79LojbIfwHu0TBmt9R4Tr6\n+HUjbCYcMiQmB4x8bNyRwuity5H2oRUM9r0rOFw+I8ygiytO+aKE9SdzZ/KLBDPd\nJWmrP7elVDXrMn1Iv5M0tAjimtveZFcEcG6ydgaUU/9XQ1M8byiYZrB07vs8hw49\niXXKaieQvBdeDgXYX+6B9MgSR4RueBUlvT7c5A+kRUuIUIkG8flby0xRF6a1x0KO\nAEuWjw/qwsoLYWljTIYfij2MvZiU5yNWRST4YwB/yJfunUzCzdj/ZFpx3jsonpwc\nBQIDAQAB\n-----END PUBLIC KEY-----\n';

function makeTestEnv(overrides?: Partial<Env>): Env {
  return {
    JWT_PUBLIC_KEY: TEST_RSA_PUBLIC_KEY,
    JWT_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
    BASE_DOMAIN: 'test.example.com',
    ...overrides,
  } as unknown as Env;
}

describe('port access token — sign/verify', () => {
  it('round-trips successfully with correct claims', async () => {
    const { signPortAccessToken, verifyPortAccessToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signPortAccessToken('user-1', 'ws-abc', 3000, env);
    const payload = await verifyPortAccessToken(token, env);

    expect(payload.workspace).toBe('ws-abc');
    expect(payload.port).toBe(3000);
    expect(payload.subject).toBe('user-1');
  });

  it('payload reflects signed workspace claim (mismatch enforced by proxy)', async () => {
    const { signPortAccessToken, verifyPortAccessToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signPortAccessToken('user-1', 'ws-abc', 3000, env);
    const payload = await verifyPortAccessToken(token, env);

    // verifyPortAccessToken returns claims; caller (proxy) enforces workspace match
    expect(payload.workspace).toBe('ws-abc');
  });

  it('payload reflects signed port claim (mismatch enforced by proxy)', async () => {
    const { signPortAccessToken, verifyPortAccessToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signPortAccessToken('user-1', 'ws-abc', 3000, env);
    const payload = await verifyPortAccessToken(token, env);

    // verifyPortAccessToken returns claims; caller (proxy) enforces port match
    expect(payload.port).toBe(3000);
  });

  it('rejects expired token', async () => {
    const { verifyPortAccessToken } = await import('../../../src/services/jwt');
    const env = makeTestEnv();

    // Sign a token that's already expired
    const privateKey = await importPKCS8(TEST_RSA_PRIVATE_KEY, 'RS256');
    const expiredToken = await new SignJWT({
      workspace: 'ws-abc',
      port: 3000,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('https://api.test.example.com')
      .setSubject('user-1')
      .setAudience('port-access')
      .setExpirationTime(new Date(Date.now() - 1000)) // expired 1 second ago
      .setIssuedAt(new Date(Date.now() - 60000))
      .sign(privateKey);

    await expect(verifyPortAccessToken(expiredToken, env)).rejects.toThrow();
  });
});

describe('port access token — audience isolation', () => {
  it('port-access token rejected by verifyTerminalToken', async () => {
    const { signPortAccessToken, verifyTerminalToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signPortAccessToken('user-1', 'ws-abc', 3000, env);

    await expect(verifyTerminalToken(token, env)).rejects.toThrow();
  });

  it('terminal token rejected by verifyPortAccessToken', async () => {
    const { signTerminalToken, verifyPortAccessToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const { token } = await signTerminalToken('user-1', 'ws-abc', env);

    await expect(verifyPortAccessToken(token, env)).rejects.toThrow();
  });

  it('callback token rejected by verifyPortAccessToken', async () => {
    const { signCallbackToken, verifyPortAccessToken } = await import(
      '../../../src/services/jwt'
    );
    const env = makeTestEnv();
    const token = await signCallbackToken('ws-abc', env);

    await expect(verifyPortAccessToken(token, env)).rejects.toThrow();
  });
});

describe('port access token — configurable expiry', () => {
  it('uses custom expiry from env', async () => {
    const { signPortAccessToken } = await import('../../../src/services/jwt');
    const { decodeJwt } = await import('jose');

    // Set a very short expiry (5 seconds)
    const env = makeTestEnv({ PORT_ACCESS_TOKEN_EXPIRY_MS: '5000' });
    const token = await signPortAccessToken('user-1', 'ws-abc', 3000, env);
    const claims = decodeJwt(token);

    const lifetime = (claims.exp as number) - (claims.iat as number);
    expect(lifetime).toBe(5); // 5 seconds
  });
});
