import { describe, expect, it } from 'vitest';
import { signRegistryToken, verifyRegistryToken, type RegistryTokenClaims } from '../src/jwt';

const SECRET = 'test-signing-secret';
const EXPECTED = { issuer: 'sam-registry-proxy', audience: 'sam-registry-proxy' };

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
    const verified = await verifyRegistryToken(token, SECRET, EXPECTED);
    expect(verified).toEqual(claims);
  });

  it('rejects tokens signed with a different secret', async () => {
    const token = await signRegistryToken(makeClaims(), 'other-secret');
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signRegistryToken(makeClaims({ iat: now - 700, exp: now - 100 }), SECRET);
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects tampered payloads', async () => {
    const token = await signRegistryToken(makeClaims(), SECRET);
    const [header, payload, sig] = token.split('.');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    decoded.sub = 'attacker';
    const tampered = btoa(JSON.stringify(decoded))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/={1,2}$/, '');
    expect(await verifyRegistryToken(`${header}.${tampered}.${sig}`, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects structurally invalid tokens', async () => {
    expect(await verifyRegistryToken('not-a-jwt', SECRET, EXPECTED)).toBeNull();
    expect(await verifyRegistryToken('a.b', SECRET, EXPECTED)).toBeNull();
    expect(await verifyRegistryToken('a.b.c.d', SECRET, EXPECTED)).toBeNull();
    expect(await verifyRegistryToken('!!!.@@@.###', SECRET, EXPECTED)).toBeNull();
  });

  // Swap the (valid) HS256 header for a different one while keeping the
  // original payload and signature.
  async function withHeader(headerJson: string): Promise<string> {
    const token = await signRegistryToken(makeClaims(), SECRET);
    const [, payload, sig] = token.split('.');
    const forgedHeader = btoa(headerJson)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/={1,2}$/, '');
    return `${forgedHeader}.${payload}.${sig}`;
  }

  it("rejects alg 'none' tokens (algorithm confusion)", async () => {
    const token = await withHeader('{"alg":"none","typ":"JWT"}');
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it("rejects alg 'RS256' tokens", async () => {
    const token = await withHeader('{"alg":"RS256","typ":"JWT"}');
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects tokens with a missing alg header', async () => {
    const token = await withHeader('{"typ":"JWT"}');
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects tokens with a mismatched issuer', async () => {
    const token = await signRegistryToken(makeClaims({ iss: 'someone-else' }), SECRET);
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects tokens with a mismatched audience', async () => {
    const token = await signRegistryToken(makeClaims({ aud: 'other-registry' }), SECRET);
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });

  it('rejects tokens missing required claim shapes', async () => {
    const noAccess = makeClaims();
    // @ts-expect-error — intentionally corrupt for the test
    noAccess.access = 'not-an-array';
    const token = await signRegistryToken(noAccess, SECRET);
    expect(await verifyRegistryToken(token, SECRET, EXPECTED)).toBeNull();
  });
});
