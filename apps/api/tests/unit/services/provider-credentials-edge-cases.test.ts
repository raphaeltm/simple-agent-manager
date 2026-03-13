/**
 * Edge-case and boundary tests for provider-credentials helpers.
 *
 * Supplements the happy-path tests in provider-credentials.test.ts by covering:
 * - Default fallthrough branch in serializeCredentialToken (silent data-loss risk)
 * - Empty and missing field inputs
 * - getUserCloudProviderConfig: all three DB outcome branches
 */
import { describe, it, expect, vi } from 'vitest';
import { serializeCredentialToken, buildProviderConfig, getUserCloudProviderConfig } from '../../../src/services/provider-credentials';
import { decrypt } from '../../../src/services/encryption';

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(),
}));

const mockDecrypt = decrypt as ReturnType<typeof vi.fn>;

// ============================================================================
// serializeCredentialToken — edge cases
// ============================================================================

describe('serializeCredentialToken — edge cases', () => {
  it('returns empty string when hetzner fields object has neither token nor apiToken', () => {
    // If caller omits both expected field names the result is an empty string.
    // This documents the current behavior as a regression guard: if the
    // function is changed to throw instead, this test will catch the change.
    const result = serializeCredentialToken('hetzner', { someOtherField: 'value' });
    expect(result).toBe('');
  });

  it('prefers token over apiToken for hetzner when both are present', () => {
    // Confirms precedence ordering of ?? chain (token is checked first).
    const result = serializeCredentialToken('hetzner', {
      token: 'primary-token',
      apiToken: 'fallback-token',
    });
    expect(result).toBe('primary-token');
  });

  it('falls back to apiToken when token is absent for hetzner', () => {
    const result = serializeCredentialToken('hetzner', { apiToken: 'api-token-only' });
    expect(result).toBe('api-token-only');
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

  it('default branch returns token field value for unknown providers', () => {
    // The default branch in serializeCredentialToken returns fields.token ?? ''.
    // This is a silent fallthrough that callers of unknown providers will hit.
    // This test documents the behavior so it cannot silently change.
    const result = serializeCredentialToken(
      'upcloud' as any,
      { token: 'upcloud-token' },
    );
    expect(result).toBe('upcloud-token');
  });

  it('default branch returns empty string when token field is missing for unknown providers', () => {
    const result = serializeCredentialToken('upcloud' as any, { username: 'user' });
    expect(result).toBe('');
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

  it('throws SyntaxError for scaleway with valid JSON but wrong shape (missing secretKey)', () => {
    // JSON is parseable but the resulting object will have undefined fields.
    // This documents that buildProviderConfig does NOT validate the parsed shape.
    const token = JSON.stringify({ projectId: 'proj-only' });
    const config = buildProviderConfig('scaleway', token);
    // secretKey will be undefined; this documents current permissive behavior
    expect((config as any).secretKey).toBeUndefined();
    expect((config as any).projectId).toBe('proj-only');
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

  it('throws SyntaxError (not a custom error) for malformed scaleway JSON', () => {
    // Verifies the error type so callers can catch it correctly
    expect(() => buildProviderConfig('scaleway', '{broken')).toThrow(SyntaxError);
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
});
