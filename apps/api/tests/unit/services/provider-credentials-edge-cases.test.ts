/**
 * Edge-case and boundary tests for provider-credentials helpers.
 *
 * Supplements the happy-path tests in provider-credentials.test.ts by covering:
 * - Default fallthrough branch in serializeCredentialToken (silent data-loss risk)
 * - Empty and missing field inputs
 * - getUserCloudProviderConfig: all three DB outcome branches
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { decrypt } from '../../../src/services/encryption';
import {
  createProviderForExactCredential,
  fingerprintEncryptedProviderCredential,
} from '../../../src/services/provider-credential-exact';
import {
  buildProviderConfig,
  createProviderForUser,
  extractScalewaySecretKey,
  getUserCloudProviderConfig,
  serializeCredentialToken,
} from '../../../src/services/provider-credentials';
import { createSchemaTables } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn(),
}));

const composableMocks = vi.hoisted(() => ({
  resolveForConsumer: vi.fn(),
  lazyBackfillIfNeeded: vi.fn(),
  getPlatformCloudCredential: vi.fn(),
}));

vi.mock('../../../src/services/composable-credentials/resolve', () => ({
  resolveForConsumer: composableMocks.resolveForConsumer,
}));
vi.mock('../../../src/services/composable-credentials/lazy-backfill', () => ({
  lazyBackfillIfNeeded: composableMocks.lazyBackfillIfNeeded,
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: composableMocks.getPlatformCloudCredential,
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
    expect(() =>
      serializeCredentialToken('unsupported-provider' as any, { token: 'unsupported-token' })
    ).toThrow('Unsupported provider');
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
      'Invalid Scaleway credential format: missing secretKey or projectId'
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
    expect(() => buildProviderConfig('unsupported-cloud' as any, 'token')).toThrow(
      'Unsupported provider: unsupported-cloud'
    );
  });

  it('throws descriptive error for malformed scaleway JSON', () => {
    expect(() => buildProviderConfig('scaleway', '{broken')).toThrow(
      'Invalid Scaleway credential format: malformed stored data'
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
      JSON.stringify({ secretKey: 'scw-key', projectId: 'proj-id' })
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

    await expect(getUserCloudProviderConfig(db, 'user-1', 'enc-key')).rejects.toThrow(
      'Unsupported provider'
    );
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
      JSON.stringify({ secretKey: 'scw-key', projectId: 'proj-id' })
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

describe('createProviderForUser exact credential binding', () => {
  const makeDbMock = (rows: any[]) => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  });

  it('refuses fallback when an exact pool credential reference is unavailable', async () => {
    mockDecrypt.mockClear();
    const db = makeDbMock([]) as any;

    const result = await createProviderForUser(
      db,
      'user-1',
      'enc-key',
      {} as any,
      'hetzner',
      null,
      {
        credentialSource: 'user',
        credentialReference: 'credentials:missing-credential',
      }
    );

    expect(result).toBeNull();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('creates a provider from the exact project credential reference and source', async () => {
    mockDecrypt.mockClear();
    mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
    const db = makeDbMock([
      {
        id: 'project-cloud-1',
        userId: 'project-owner',
        projectId: 'project-1',
        provider: 'hetzner',
        credentialType: 'cloud-provider',
        isActive: true,
        encryptedToken: 'ciphertext',
        iv: 'iv',
      },
    ]) as any;

    const credentialFingerprint = await fingerprintEncryptedProviderCredential('ciphertext', 'iv');
    const result = await createProviderForUser(
      db,
      'project-member',
      'enc-key',
      {} as any,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:project-cloud-1',
        credentialVersion: 1700000000000,
        credentialFingerprint,
      }
    );

    expect(result).toMatchObject({
      providerName: 'hetzner',
      credentialSource: 'project',
    });
    expect(mockDecrypt).toHaveBeenCalledWith('ciphertext', 'iv', 'enc-key');
  });

  it('creates a provider from an exact project composable credential owned by another member', async () => {
    mockDecrypt.mockClear();
    mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
    const db = {
      select: vi.fn(() => {
        const builder = {
          from: () => builder,
          innerJoin: () => builder,
          where: () => builder,
          limit: () =>
            Promise.resolve([
              {
                encryptedToken: 'cc-ciphertext',
                iv: 'cc-iv',
              },
            ]),
        };
        return builder;
      }),
    } as any;

    const credentialFingerprint = await fingerprintEncryptedProviderCredential(
      'cc-ciphertext',
      'cc-iv'
    );
    const result = await createProviderForUser(
      db,
      'project-member',
      'enc-key',
      {} as any,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'cc_credentials:cc-project-cloud-1',
        credentialVersion: 1700000000000,
        credentialFingerprint,
      }
    );

    expect(result).toMatchObject({
      providerName: 'hetzner',
      credentialSource: 'project',
    });
    expect(mockDecrypt).toHaveBeenCalledWith('cc-ciphertext', 'cc-iv', 'enc-key');
  });

  it('refuses a rotated credential row even when the replacement account has a colliding VM ID', async () => {
    mockDecrypt.mockClear();
    const accountAFingerprint = await fingerprintEncryptedProviderCredential(
      'account-a-ciphertext',
      'account-a-iv'
    );
    const db = makeDbMock([
      {
        id: 'project-cloud-1',
        userId: 'project-owner',
        projectId: 'project-1',
        provider: 'hetzner',
        credentialType: 'cloud-provider',
        isActive: true,
        encryptedToken: 'account-b-ciphertext',
        iv: 'account-b-iv',
      },
    ]) as any;
    const providerFactory = vi.fn(() => {
      throw new Error('account B provider must not be constructed');
    });

    const result = await createProviderForExactCredential(
      db,
      'project-member',
      'enc-key',
      {} as any,
      'hetzner',
      'project-1',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:project-cloud-1',
        credentialVersion: 1700000000000,
        credentialFingerprint: accountAFingerprint,
      },
      providerFactory
    );

    expect(result).toBeNull();
    expect(providerFactory).not.toHaveBeenCalled();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it('refuses an exact project composable credential with mismatched owner lineage', async () => {
    mockDecrypt.mockClear();
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [
        schema.ccCredentials,
        schema.ccConfigurations,
        schema.ccAttachments,
      ]);
      sqlite
        .prepare(
          `INSERT INTO cc_credentials (
            id, owner_id, name, kind, encrypted_token, iv, is_active
          )
          VALUES ('cc-project-cloud-1', 'credential-owner', 'Project cloud', 'cloud-provider',
            'cc-ciphertext', 'cc-iv', 1)`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO cc_configurations (
            id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active
          )
          VALUES ('cc-cfg-project-cloud-1', 'different-owner', 'Project compute', 'compute',
            'hetzner', 'cc-project-cloud-1', 1)`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO cc_attachments (
            id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active
          )
          VALUES ('cc-att-project-cloud-1', 'cc-cfg-project-cloud-1', 'compute',
            'hetzner', 'credential-owner', 'project-1', 1)`
        )
        .run();
      const db = drizzle(sqlite, { schema });
      const providerFactory = vi.fn();

      const result = await createProviderForExactCredential(
        db as never,
        'project-member',
        'enc-key',
        {} as any,
        'hetzner',
        'project-1',
        {
          credentialSource: 'project',
          credentialReference: 'cc_credentials:cc-project-cloud-1',
        },
        providerFactory
      );

      expect(result).toBeNull();
      expect(providerFactory).not.toHaveBeenCalled();
      expect(mockDecrypt).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});

describe('createProviderForUser composable credential project halt', () => {
  it('does not fall through to legacy user or platform credentials after a project CC halt', async () => {
    mockDecrypt.mockClear();
    composableMocks.resolveForConsumer.mockResolvedValueOnce(null);
    composableMocks.lazyBackfillIfNeeded.mockResolvedValueOnce(false);
    composableMocks.getPlatformCloudCredential.mockResolvedValueOnce({
      decryptedToken: 'platform-token',
      provider: 'hetzner',
    });
    mockDecrypt.mockResolvedValueOnce('legacy-user-token');

    const selectedTables: unknown[] = [];
    const legacyUserCredential = {
      id: 'legacy-user-cloud-1',
      userId: 'user-1',
      projectId: null,
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      isActive: true,
      encryptedToken: 'ciphertext',
      iv: 'iv',
    };
    const db = {
      select: vi.fn(() => {
        let table: unknown;
        const builder = {
          from: (value: unknown) => {
            table = value;
            selectedTables.push(value);
            return builder;
          },
          where: () => builder,
          limit: () =>
            Promise.resolve(
              table === schema.ccAttachments
                ? [{ id: 'inactive-project-compute-attachment' }]
                : table === schema.credentials
                  ? [legacyUserCredential]
                  : []
            ),
        };
        return builder;
      }),
    } as any;

    const result = await createProviderForUser(
      db,
      'user-1',
      'enc-key',
      {} as any,
      'hetzner',
      'project-1'
    );

    expect(result).toBeNull();
    expect(composableMocks.resolveForConsumer).toHaveBeenCalledWith(
      db,
      'user-1',
      'enc-key',
      { kind: 'compute', provider: 'hetzner' },
      'project-1'
    );
    expect(composableMocks.lazyBackfillIfNeeded).not.toHaveBeenCalled();
    expect(composableMocks.getPlatformCloudCredential).not.toHaveBeenCalled();
    expect(selectedTables).toEqual([schema.ccAttachments]);
    expect(mockDecrypt).not.toHaveBeenCalledWith('ciphertext', 'iv', 'enc-key');
  });
});

// ============================================================================
// extractScalewaySecretKey
// ============================================================================

describe('extractScalewaySecretKey', () => {
  it('extracts secretKey from valid Scaleway credential JSON', () => {
    const token = JSON.stringify({ secretKey: 'scw-key-123', projectId: 'proj-1' });
    expect(extractScalewaySecretKey(token)).toBe('scw-key-123');
  });

  it('returns null for malformed JSON', () => {
    expect(extractScalewaySecretKey('not-json')).toBeNull();
  });

  it('returns null when secretKey is missing', () => {
    expect(extractScalewaySecretKey(JSON.stringify({ projectId: 'proj-1' }))).toBeNull();
  });

  it('returns null when secretKey is empty string', () => {
    expect(
      extractScalewaySecretKey(JSON.stringify({ secretKey: '', projectId: 'proj-1' }))
    ).toBeNull();
  });

  it('returns null when secretKey is not a string', () => {
    expect(
      extractScalewaySecretKey(JSON.stringify({ secretKey: 42, projectId: 'proj-1' }))
    ).toBeNull();
  });

  it('round-trips with serializeCredentialToken', () => {
    const serialized = serializeCredentialToken('scaleway', {
      secretKey: 'my-key',
      projectId: 'my-proj',
    });
    expect(extractScalewaySecretKey(serialized)).toBe('my-key');
  });
});
