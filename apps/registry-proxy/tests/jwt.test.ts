import { describe, expect, it } from 'vitest';
import { signRegistryToken, verifyRegistryToken, type RegistryTokenClaims } from '../src/jwt';

const SECRET = 'test-signing-secret';

function makeClaims(overrides: Partial<RegistryTokenClaims> = {}): RegistryTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: 'proj1',
    iss: 'sam-registry-proxy',
    aud: 'sam-registry-proxy',
    iat: now,
    exp: now + 600,
    access: [{ type: 'repository', name: 'proj-proj1/app', actions: ['pull', 'push'] }],
    ...overrides,
  };
}

describe('registry token sign/verify', () => {
  it('roundtrips claims', async () => {
    const claims = makeClaims();
    const token = await signRegistryToken(claims, SECRET);
    const verified = await verifyRegistryToken(token, SECRET);
    expect(verified).toEqual(claims);
  });

  it('rejects tokens signed with a different secret', async () => {
    const token = await signRegistryToken(makeClaims(), 'other-secret');
    expect(await verifyRegistryToken(token, SECRET)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signRegistryToken(makeClaims({ iat: now - 700, exp: now - 100 }), SECRET);
    expect(await verifyRegistryToken(token, SECRET)).toBeNull();
  });

  it('rejects tampered payloads', async () => {
    const token = await signRegistryToken(makeClaims(), SECRET);
    const [header, payload, sig] = token.split('.');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    decoded.sub = 'attacker';
    const tampered = btoa(JSON.stringify(decoded))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyRegistryToken(`${header}.${tampered}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects structurally invalid tokens', async () => {
    expect(await verifyRegistryToken('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyRegistryToken('a.b', SECRET)).toBeNull();
    expect(await verifyRegistryToken('a.b.c.d', SECRET)).toBeNull();
    expect(await verifyRegistryToken('!!!.@@@.###', SECRET)).toBeNull();
  });

  it('rejects tokens missing required claim shapes', async () => {
    const noAccess = makeClaims();
    // @ts-expect-error — intentionally corrupt for the test
    noAccess.access = 'not-an-array';
    const token = await signRegistryToken(noAccess, SECRET);
    expect(await verifyRegistryToken(token, SECRET)).toBeNull();
  });
});
