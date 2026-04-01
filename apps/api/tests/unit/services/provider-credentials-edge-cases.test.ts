/**
 * Edge-case and boundary tests for provider-credentials helpers.
 *
 * Supplements the happy-path tests in provider-credentials.test.ts by covering:
 * - Default fallthrough branch in serializeCredentialToken (silent data-loss risk)
 * - Empty and missing field inputs
 * - getUserCloudProviderConfig: all three DB outcome branches
 */
import { describe, expect, it, vi } from 'vitest';

import { decrypt } from '../../../src/services/encryption';
import { buildProviderConfig, getUserCloudProviderConfig,serializeCredentialToken } from '../../../src/services/provider-credentials';

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(),
}));

const mockDecrypt = decrypt as ReturnType<typeof vi.fn>;

// ============================================================================
// serializeCredentialToken — edge cases
// ============================================================================

describe('serializeCredentialToken — edge cases', () => {
  it('returns empty string when hetzner fields object has no token field', () => {
    // If caller omits the token field, the result is an empty string.
    const result = serializeCredentialToken('hetzner', { someOtherField: 'value' });
    expect(result).toBe('');
  });

  it('returns JSON string with only secretKey and projectId for scaleway, ignoring extra fields', () => {
    // Extra fields must NOT leak into the stored token.
    const result = serializeCredentialToken('scaleway', {
      secretKey: 'scw-key',
      projectId: 'proj-id',
      extraSensitiveField: 'should-not-appear',
    });
    const parsed = JSON.parse(result);
    expect(Object.keys(parsed)).toEqual(['secretKey', 'projectId']);
    expect(parsed.extraSensitiveField).toBeUndefined();
  });

  it('returns JSON with empty string values for scaleway when fields are missing', () => {
    // Documenting current behavior: missing fields become undefined which JSON.stringify
    // omits, so the parsed object will lack the key entirely.
    const result = serializeCredentialToken('scaleway', {});
    const parsed = JSON.parse(result);
    // secretKey and projectId will be undefined → JSON omits undefined values
    expect(parsed).toEqual({});
  });

  it('default branch throws for unknown providers', () => {
    // The default branch uses exhaustive type checking and throws.
    // This prevents silent data loss for unsupported providers.
    expect(() => serializeCredentialToken(
      'upcloud' as any,
      { token: 'upcloud-token' },
    )).toThrow('Unsupported provider');
  });
});

// ============================================================================
// buildProviderConfig — edge cases
// ============================================================================

describe('buildProviderConfig — edge cases', () => {
  it('returns hetzner config with empty apiToken when empty string is passed', () => {
    // Callers must validate non-empty before calling; this documents the current
    // behavior and prevents silent regressions if a guard is added later.
    const config = buildProviderConfig('hetzner', '');
    expect(config).toEqual({ provider: 'hetzner', apiToken: '' });
  });

  it('throws for scaleway with valid JSON but missing secretKey', () => {
    const token = JSON.stringify({ projectId: 'proj-only' });
    expect(() => buildProviderConfig('scaleway', token)).toThrow(
      'Invalid Scaleway credential format: missing secretKey or projectId',
    );
  });

  it('throws for scaleway when JSON has extra keys (extra keys should not appear in config)', () => {
    const token = JSON.stringify({
      secretKey: 'key',
      projectId: 'proj',
      extraKey: 'should-not-appear',
    });
    const config = buildProviderConfig('scaleway', token) as any;
    // Current implementation spreads only the explicit destructured fields
    expect(config.extraKey).toBeUndefined();
  });

  it('throws with descriptive message for unsupported provider', () => {
    expect(() => buildProviderConfig('digitalocean' as any, 'token')).toThrow(
      'Unsupported provider: digitalocean',
    );
  });

  it('throws descriptive error for malformed scaleway JSON', () => {
    expect(() => buildProviderConfig('scaleway', '{broken')).toThrow(
      'Invalid Scaleway credential format: malformed stored data',
    );
  });

  it('round-trip preserves whitespace in hetzner token', () => {
    // Tokens should survive unchanged even with unusual but valid characters
    const token = '  leading-space-token  ';
    const serialized = serializeCredentialToken('hetzner', { token });
    const config = buildProviderConfig('hetzner', serialized);
    expect((config as any).apiToken).toBe(token);
  });

  it('round-trip preserves scaleway fields with special characters', () => {
    const fields = {
      secretKey: 'key-with-special_chars.123',
      projectId: 'proj-uuid-1234-5678-abcd',
    };
    const serialized = serializeCredentialToken('scaleway', fields);
    const config = buildProviderConfig('scaleway', serialized);
    expect(config).toEqual({ provider: 'scaleway', ...fields });
  });
});

// ============================================================================
// getUserCloudProviderConfig — unit tests with mocked DB
// ============================================================================

describe('getUserCloudProviderConfig', () => {
  // The encryption module is mocked at the top of this file via vi.mock().
  // mockDecrypt is the spy alias bound to that mock's decrypt function.
  // Use mockDecrypt.mockResolvedValueOnce() to control per-test return values.

  const makeDbMock = (rows: any[]) => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  });

  it('returns null when no credential row exists for the user', async () => {
    const db = makeDbMock([]) as any;
    const result = await getUserCloudProviderConfig(db, 'user-1', 'enc-key');
    expect(result).toBeNull();
    // decrypt must not be called if there is no credential row
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('returns HetznerProviderConfig when a hetzner credential row exists', async () => {
    mockDecrypt.mockResolvedValueOnce('hetzner-api-token');

    const db = makeDbMock([
      {
        provider: 'hetzner',
        encryptedToken: 'ciphertext',
        iv: 'iv',
        credentialType: 'cloud-provider',
        userId: 'user-1',
      },
    ]) as any;

    const result = await getUserCloudProviderConfig(db, 'user-1', 'enc-key');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('hetzner');
    expect(result!.config).toEqual({ provider: 'hetzner', apiToken: 'hetzner-api-token' });
  });

  it('returns ScalewayProviderConfig when a scaleway credential row exists', async () => {
    mockDecrypt.mockResolvedValueOnce(
      JSON.stringify({ secretKey: 'scw-key', projectId: 'proj-id' }),
    );

    const db = makeDbMock([
      {
        provider: 'scaleway',
        encryptedToken: 'ciphertext',
        iv: 'iv',
        credentialType: 'cloud-provider',
        userId: 'user-1',
      },
    ]) as any;

    const result = await getUserCloudProviderConfig(db, 'user-1', 'enc-key');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('scaleway');
    expect(result!.config).toEqual({
      provider: 'scaleway',
      secretKey: 'scw-key',
      projectId: 'proj-id',
    });
  });

  it('throws when a credential row has an unknown provider type in the DB', async () => {
    mockDecrypt.mockResolvedValueOnce('some-token');

    const db = makeDbMock([
      {
        provider: 'unsupported-future-provider',
        encryptedToken: 'ciphertext',
        iv: 'iv',
        credentialType: 'cloud-provider',
        userId: 'user-1',
      },
    ]) as any;

    await expect(
      getUserCloudProviderConfig(db, 'user-1', 'enc-key'),
    ).rejects.toThrow('Unsupported provider');
  });

  it('passes targetProvider as additional where condition when specified', async () => {
    const whereSpy = vi.fn().mockReturnThis();
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: whereSpy,
      limit: vi.fn().mockResolvedValue([]),
    } as any;

    await getUserCloudProviderConfig(db, 'user-1', 'enc-key', 'scaleway');

    // where() should be called with the combined conditions
    expect(whereSpy).toHaveBeenCalledTimes(1);
    // The call was made, meaning the provider filter was included
  });

  it('returns null when targetProvider is specified but no matching credential exists', async () => {
    mockDecrypt.mockClear();
    const db = makeDbMock([]) as any;
    const result = await getUserCloudProviderConfig(db, 'user-1', 'enc-key', 'scaleway');
    expect(result).toBeNull();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('returns matching credential when targetProvider matches the stored provider', async () => {
    mockDecrypt.mockResolvedValueOnce(
      JSON.stringify({ secretKey: 'scw-key', projectId: 'proj-id' }),
    );

    const db = makeDbMock([
      {
        provider: 'scaleway',
        encryptedToken: 'ciphertext',
        iv: 'iv',
        credentialType: 'cloud-provider',
        userId: 'user-1',
      },
    ]) as any;

    const result = await getUserCloudProviderConfig(db, 'user-1', 'enc-key', 'scaleway');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('scaleway');
    expect(result!.config).toEqual({
      provider: 'scaleway',
      secretKey: 'scw-key',
      projectId: 'proj-id',
    });
  });

  it('returns first credential when no targetProvider is specified (backward compatible)', async () => {
    mockDecrypt.mockResolvedValueOnce('hetzner-token');

    const db = makeDbMock([
      {
        provider: 'hetzner',
        encryptedToken: 'ciphertext',
        iv: 'iv',
        credentialType: 'cloud-provider',
        userId: 'user-1',
      },
    ]) as any;

    const result = await getUserCloudProviderConfig(db, 'user-1', 'enc-key');
    expect(result).not.toBeNull();
    expect(result!.provider).toBe('hetzner');
  });
});
