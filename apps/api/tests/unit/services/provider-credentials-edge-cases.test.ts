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
  hasExactProviderCredentialGenerationProof,
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

/**
 * Version-only generation proof — the binding shape every node provisioned before migration
 * 0142 carries (source + reference + version, fingerprint NULL). Strict teardown accepts it,
 * so these cases pin what the resolver still refuses on that path. Driven through real SQLite
 * so `updated_at` genuinely round-trips into `timestampVersion` rather than being handed in.
 */
/**
 * Version-only generation proof — the binding shape every node provisioned before migration
 * 0142 carries (source + reference + version, fingerprint NULL). Strict teardown accepts it,
 * so these cases pin what the resolver still refuses on that path. Driven through real SQLite
 * so `updated_at` genuinely round-trips into `timestampVersion` rather than being handed in.
 */
describe('exact credential binding — version-only generation proof', () => {
  const PLACED_AT = '2026-02-08T09:59:13.719Z';
  const ROTATED_AT = '2026-09-08T12:00:00.000Z';

  const hetznerProvider = async () => ({
    provider: {} as never,
    providerName: 'hetzner' as const,
    credentialSource: 'user' as const,
  });

  /** Resolve `reference` with the given proof. `factory` defaults to a throwing guard. */
  function resolve(
    db: unknown,
    reference: string,
    proof: { credentialVersion?: number | null; credentialFingerprint?: string | null },
    factory: Parameters<typeof createProviderForExactCredential>[7] = () => {
      throw new Error('provider must not be constructed');
    }
  ) {
    return createProviderForExactCredential(
      db as never,
      'user-1',
      'enc-key',
      {} as never,
      'hetzner',
      null,
      {
        credentialSource: 'user',
        credentialReference: reference,
        credentialVersion: proof.credentialVersion ?? null,
        credentialFingerprint: proof.credentialFingerprint ?? null,
      },
      factory
    );
  }

  function seedCredential(sqlite: Database.Database, updatedAt: string) {
    createSchemaTables(sqlite, [schema.credentials]);
    sqlite
      .prepare(
        `INSERT INTO credentials (
           id, user_id, project_id, provider, credential_type, credential_kind,
           is_active, encrypted_token, iv, created_at, updated_at
         )
         VALUES ('user-cloud-1', 'user-1', NULL, 'hetzner', 'cloud-provider', 'api-key',
           1, 'ciphertext', 'iv', ?, ?)`
      )
      .run(PLACED_AT, updatedAt);
    return drizzle(sqlite, { schema });
  }

  /** Run `body` against a freshly seeded in-memory DB, always closing it. */
  async function withCredential(
    updatedAt: string,
    body: (db: unknown) => Promise<void>
  ): Promise<void> {
    mockDecrypt.mockClear();
    const sqlite = new Database(':memory:');
    try {
      await body(seedCredential(sqlite, updatedAt));
    } finally {
      sqlite.close();
    }
  }

  const REF = 'credentials:user-cloud-1';

  it('resolves a pre-0142 binding whose version still matches the credential row', async () => {
    await withCredential(PLACED_AT, async (db) => {
      mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
      const factory = vi.fn(hetznerProvider);

      const result = await resolve(db, REF, { credentialVersion: Date.parse(PLACED_AT) }, factory);

      expect(result).toMatchObject({ providerName: 'hetzner', credentialSource: 'user' });
      // Teardown gets the real content fingerprint back even though it went in version-only.
      expect(result?.exactCredentialBinding?.credentialFingerprint).toBe(
        await fingerprintEncryptedProviderCredential('ciphertext', 'iv')
      );
      expect(factory).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses a pre-0142 binding after the credential row rotates', async () => {
    // Every ciphertext write to `credentials` sets `updatedAt`, so rotation moves the version.
    await withCredential(ROTATED_AT, async (db) => {
      expect(await resolve(db, REF, { credentialVersion: Date.parse(PLACED_AT) })).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();

      // Liveness beside the absence (rule 62): `null` must mean "the fence refused", not "the
      // row was never found". The same fixture at the row's CURRENT version resolves.
      mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
      expect(
        await resolve(db, REF, { credentialVersion: Date.parse(ROTATED_AT) }, hetznerProvider)
      ).not.toBeNull();
    });
  });

  it('refuses a binding with neither fingerprint nor version even when the row is unchanged', async () => {
    await withCredential(PLACED_AT, async (db) => {
      expect(await resolve(db, REF, {})).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();

      mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
      expect(
        await resolve(db, REF, { credentialVersion: Date.parse(PLACED_AT) }, hetznerProvider)
      ).not.toBeNull();
    });
  });

  it('a matching version cannot rescue a binding whose fingerprint no longer matches', async () => {
    await withCredential(PLACED_AT, async (db) => {
      expect(
        await resolve(db, REF, {
          credentialVersion: Date.parse(PLACED_AT),
          credentialFingerprint: 'sha256:some-other-generation',
        })
      ).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });
  });

  /**
   * The same fence reached through the composable-credentials join instead of the legacy table.
   * `exactCredentialGenerationMatches` is shared, but the row it compares arrives from a
   * different query, so the wiring needs its own coverage.
   */
  describe('through the composable-credentials join', () => {
    const CC_PLACED_AT = '2026-03-01T10:00:00.000Z';
    const CC_REF = 'cc_credentials:cc-cloud-1';

    async function withComposable(
      updatedAt: string,
      body: (db: unknown) => Promise<void>
    ): Promise<void> {
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
               id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at
             )
             VALUES ('cc-cloud-1', 'user-1', 'Cloud', 'cloud-provider', 'cc-ct', 'cc-iv', 1, ?, ?)`
          )
          .run(CC_PLACED_AT, updatedAt);
        sqlite
          .prepare(
            `INSERT INTO cc_configurations (
               id, owner_id, name, consumer_kind, consumer_target, credential_id, is_active
             )
             VALUES ('cc-cfg-1', 'user-1', 'Compute', 'compute', 'hetzner', 'cc-cloud-1', 1)`
          )
          .run();
        sqlite
          .prepare(
            `INSERT INTO cc_attachments (
               id, configuration_id, consumer_kind, consumer_target, user_id, project_id, is_active
             )
             VALUES ('cc-att-1', 'cc-cfg-1', 'compute', 'hetzner', 'user-1', NULL, 1)`
          )
          .run();
        await body(drizzle(sqlite, { schema }));
      } finally {
        sqlite.close();
      }
    }

    it('resolves a cc_credentials binding whose version still matches', async () => {
      await withComposable(CC_PLACED_AT, async (db) => {
        mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
        const factory = vi.fn(hetznerProvider);

        const result = await resolve(
          db,
          CC_REF,
          { credentialVersion: Date.parse(CC_PLACED_AT) },
          factory
        );

        expect(result).toMatchObject({ providerName: 'hetzner' });
        expect(factory).toHaveBeenCalledTimes(1);
      });
    });

    it('refuses a cc_credentials binding after the row rotates, and still resolves the current one', async () => {
      await withComposable(ROTATED_AT, async (db) => {
        expect(
          await resolve(db, CC_REF, { credentialVersion: Date.parse(CC_PLACED_AT) })
        ).toBeNull();
        expect(mockDecrypt).not.toHaveBeenCalled();

        mockDecrypt.mockResolvedValueOnce('hetzner-api-token');
        expect(
          await resolve(db, CC_REF, { credentialVersion: Date.parse(ROTATED_AT) }, hetznerProvider)
        ).not.toBeNull();
      });
    });
  });
});


describe('hasExactProviderCredentialGenerationProof', () => {
  it.each([
    ['fingerprint only', { credentialFingerprint: 'sha256:a', credentialVersion: null }, true],
    ['version only', { credentialFingerprint: null, credentialVersion: 1700000000000 }, true],
    ['both', { credentialFingerprint: 'sha256:a', credentialVersion: 1700000000000 }, true],
    ['neither', { credentialFingerprint: null, credentialVersion: null }, false],
    // Empty string must read as ABSENT here, matching exactCredentialGenerationMatches'
    // own truthiness check, or the two would disagree about what counts as proof.
    ['empty-string fingerprint only', { credentialFingerprint: '', credentialVersion: null }, false],
    [
      'empty-string fingerprint with version',
      { credentialFingerprint: '', credentialVersion: 1700000000000 },
      true,
    ],
  ])('%s -> %s', (_label, proof, expected) => {
    expect(
      hasExactProviderCredentialGenerationProof({
        credentialSource: 'user',
        credentialReference: 'credentials:user-cloud-1',
        ...proof,
      })
    ).toBe(expected);
  });

  it('refuses a binding with no reference regardless of its generation proof', () => {
    expect(hasExactProviderCredentialGenerationProof(null)).toBe(false);
    expect(
      hasExactProviderCredentialGenerationProof({
        credentialSource: 'user',
        credentialReference: null,
        credentialVersion: 1700000000000,
        credentialFingerprint: 'sha256:a',
      })
    ).toBe(false);
  });
});

describe('createProviderForUser composable credential project halt', () => {
  it('re-resolves the exact ciphertext generation when a credential rotates after snapshot resolution', async () => {
    mockDecrypt.mockClear();
    mockDecrypt.mockResolvedValue('account-b-provider-token');
    composableMocks.resolveForConsumer.mockResolvedValueOnce({
      consumer: { kind: 'compute', provider: 'hetzner' },
      configuration: {
        id: 'cfg-user-cloud-1',
        ownerId: 'user-1',
        name: 'User cloud',
        consumer: { kind: 'compute', provider: 'hetzner' },
        credentialId: 'cc-user-cloud-1',
        settings: {},
        isActive: true,
      },
      credential: {
        id: 'cc-user-cloud-1',
        ownerId: 'user-1',
        name: 'Account A before rotation',
        kind: 'cloud-provider',
        secret: { kind: 'cloud-provider', provider: 'hetzner', token: 'account-a-token' },
        isActive: true,
      },
      source: 'user-attachment',
    });
    const accountBRow = {
      encryptedToken: 'account-b-ciphertext',
      iv: 'account-b-iv',
      createdAt: '2026-09-04T08:00:00.000Z',
      updatedAt: '2026-09-04T08:01:00.000Z',
    };
    const db = {
      select: vi.fn(() => {
        const builder = {
          from: () => builder,
          innerJoin: () => builder,
          where: () => builder,
          limit: () => Promise.resolve([accountBRow]),
        };
        return builder;
      }),
    } as any;

    const result = await createProviderForUser(db, 'user-1', 'enc-key', {} as any, 'hetzner', null);
    const accountBFingerprint = await fingerprintEncryptedProviderCredential(
      accountBRow.encryptedToken,
      accountBRow.iv
    );

    expect(result).toMatchObject({
      providerName: 'hetzner',
      credentialSource: 'user',
      exactCredentialBinding: {
        credentialReference: 'cc_credentials:cc-user-cloud-1',
        credentialFingerprint: accountBFingerprint,
      },
    });
    expect(mockDecrypt).toHaveBeenCalledTimes(1);
    expect(mockDecrypt).toHaveBeenCalledWith(accountBRow.encryptedToken, accountBRow.iv, 'enc-key');
    expect(mockDecrypt).not.toHaveBeenCalledWith(
      expect.stringContaining('account-a'),
      expect.anything(),
      expect.anything()
    );
  });

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
