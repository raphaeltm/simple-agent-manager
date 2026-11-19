/**
 * One owner per Google Cloud workload identity pool, on a real SQL engine.
 *
 * Attack: user B stores a GCP credential naming user A's (or the installation's) pool. Before
 * this guard SAM signed an identity token for it, A's issuer-only provider accepted it, and the
 * `pool/*` binding let B impersonate A's service account. Each attack case has an owner control,
 * and each guard was deleted once to confirm its attack case goes red (see the PR).
 */
import { readFileSync } from 'node:fs';

import { GCP_CREDENTIAL_VERSION, type GcpOidcCredential } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { encrypt } from '../../../src/services/encryption';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

const auth = vi.hoisted(() => ({ userId: 'user-a' }));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => (_c: unknown, next: () => Promise<void>) => next(),
  getUserId: () => auth.userId,
}));
vi.mock('../../../src/services/jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/jwt')>()),
  signIdentityToken: vi.fn(async () => 'sam-identity-token'),
}));

const { signIdentityToken } = await import('../../../src/services/jwt');
const { getGcpAccessToken } = await import('../../../src/services/gcp-sts');
const { replaceUserGcpCredential } = await import('../../../src/services/gcp-credential-store');
const { credentialsRoutes } = await import('../../../src/routes/credentials');
const { ccRoutes } = await import('../../../src/routes/composable-credentials');
const { runGcpSetup } = await import('../../../src/services/gcp-setup');
const {
  GcpWifPoolOwnershipUnresolvedError,
  assertGcpWifPayloadOwnership,
  GcpWifPoolIndexUnavailableError,
  GcpWifPoolInvalidError,
  GcpWifPoolOwnedByAnotherOwnerError,
} = await import('../../../src/services/gcp-wif-pool-ownership');
const { handleAppError } = await import('../../../src/middleware/app-error-handler');
const { runGcpDeploySetup } = await import('../../../src/services/gcp-deploy-setup');
const { serializeCredentialToken, createProviderForUser } =
  await import('../../../src/services/provider-credentials');
const { UNINDEXED_ROWS_SQL } = await import('../../../src/services/gcp-wif-pool-ownership-sql');

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const NOW = '2026-11-19T00:00:00.000Z';
const POOL_A = { gcpProjectNumber: '111111111111', wifPoolId: 'sam-pool' };
const POOL_PLATFORM = { gcpProjectNumber: '222222222222', wifPoolId: 'sam-pool' };
const POOL_B = { gcpProjectNumber: '333333333333', wifPoolId: 'sam-pool' };

let sqlite: Database.Database;
let env: Env;
let fetchMock: ReturnType<typeof vi.fn>;

function wif(
  pool: { gcpProjectNumber: string; wifPoolId: string },
  overrides: Partial<GcpOidcCredential> = {}
): GcpOidcCredential {
  return {
    version: GCP_CREDENTIAL_VERSION,
    provider: 'gcp',
    authType: 'workload-identity',
    gcpProjectId: `gcp-${pool.gcpProjectNumber}`,
    gcpProjectNumber: pool.gcpProjectNumber,
    serviceAccountEmail: `sam@gcp-${pool.gcpProjectNumber}.iam.gserviceaccount.com`,
    wifPoolId: pool.wifPoolId,
    wifProviderId: 'sam-provider',
    defaultZone: 'us-central1-a',
    ...overrides,
  };
}

async function sealed(plaintext: string) {
  return encrypt(plaintext, KEY);
}

/** A legacy `credentials` row stored before the save-time check existed. */
async function storeLegacyRow(
  id: string,
  userId: string,
  credential: GcpOidcCredential,
  projectId: string | null = null
) {
  const { ciphertext, iv } = await sealed(JSON.stringify(credential));
  sqlite
    .prepare(
      `INSERT INTO credentials (id, user_id, project_id, provider, credential_type, credential_kind,
         is_active, encrypted_token, iv, created_at, updated_at)
       VALUES (?, ?, ?, 'gcp', 'cloud-provider', 'api-key', 1, ?, ?, ?, ?)`
    )
    .run(id, userId, projectId, ciphertext, iv, NOW, NOW);
}

async function storePlatformRow(id: string, credential: GcpOidcCredential) {
  const { ciphertext, iv } = await sealed(JSON.stringify(credential));
  sqlite
    .prepare(
      `INSERT INTO platform_credentials (id, credential_type, provider, credential_kind, label,
         encrypted_token, iv, is_enabled, created_by, created_at, updated_at)
       VALUES (?, 'cloud-provider', 'gcp', 'api-key', 'GCP', ?, ?, 1, 'admin', ?, ?)`
    )
    .run(id, ciphertext, iv, NOW, NOW);
}

async function storeCcRow(id: string, ownerId: string, plaintext: string) {
  const { ciphertext, iv } = await sealed(plaintext);
  sqlite
    .prepare(
      `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active,
         created_at, updated_at)
       VALUES (?, ?, 'cloud', 'cloud-provider', ?, ?, 1, ?, ?)`
    )
    .run(id, ownerId, ciphertext, iv, NOW, NOW);
}

function user(userId: string) {
  return { cacheUserId: userId, poolOwner: { kind: 'user' as const, userId } };
}

function exchange(
  requester: Parameters<typeof getGcpAccessToken>[0],
  credential: GcpOidcCredential,
  projectId = credential.gcpProjectId
) {
  return getGcpAccessToken(requester, projectId, credential, env);
}

function stubGoogleTokens() {
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('sts')) {
      return Response.json({ access_token: 'federated', token_type: 'Bearer', expires_in: 3600 });
    }
    return Response.json({
      accessToken: 'sa-token',
      expireTime: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function indexRows() {
  return sqlite
    .prepare(
      'SELECT source_table, source_id, owner_kind, owner_user_id, pool_key FROM gcp_wif_pool_index ORDER BY source_table, source_id'
    )
    .all() as Array<{
    source_table: string;
    source_id: string;
    owner_kind: string;
    owner_user_id: string | null;
    pool_key: string | null;
  }>;
}

function testApp() {
  const app = new Hono<{ Bindings: Env }>();
  // The production handler, so a refusal that stopped being an AppError would surface as 500.
  app.onError(handleAppError);
  app.route('/api/credentials', credentialsRoutes);
  app.route('/api/cc', ccRoutes);
  return app;
}

function postGcpCredential(credential: GcpOidcCredential) {
  return testApp().request(
    '/api/credentials',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'gcp',
        gcpProjectId: credential.gcpProjectId,
        gcpProjectNumber: credential.gcpProjectNumber,
        serviceAccountEmail: credential.serviceAccountEmail,
        wifPoolId: credential.wifPoolId,
        wifProviderId: credential.wifProviderId,
        defaultZone: credential.defaultZone,
      }),
    },
    env
  );
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  // Exercise the real migration (its CHECK constraints and indexes), not only the drizzle shape.
  sqlite.exec('DROP TABLE gcp_wif_pool_index');
  sqlite.exec('DROP TABLE gcp_wif_pool_claims');
  sqlite.exec(
    readFileSync(
      new URL('../../../src/db/migrations/0262_gcp_wif_pool_index.sql', import.meta.url),
      'utf8'
    )
  );
  for (const id of ['user-a', 'user-b', 'user-m', 'admin']) {
    sqlite
      .prepare(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, id, NOW, NOW);
  }
  sqlite
    .prepare(
      `INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES ('proj-a', 'user-a', 'A', ?, ?)`
    )
    .run(NOW, NOW);
  env = {
    DATABASE: createSqliteD1(sqlite),
    KV: createMemoryKv(),
    ENCRYPTION_KEY: KEY,
    BASE_DOMAIN: 'example.com',
  } as unknown as Env;
  auth.userId = 'user-a';
  vi.mocked(signIdentityToken).mockClear();
  stubGoogleTokens();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});

describe('token exchange refuses a pool another owner uses (rows that predate the save check)', () => {
  it('owner control: user A exchanges with A’s own pool', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));

    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');
    expect(signIdentityToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('attack: user B naming user A’s pool is refused before any token is signed', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    // B's row was saved before the save-time check existed.
    await storeLegacyRow('cred-b', 'user-b', wif(POOL_A, { serviceAccountEmail: 'x@y.z' }));

    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    expect(signIdentityToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attack: case and whitespace variants of A’s pool are the same pool', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));

    await expect(
      exchange(
        user('user-b'),
        wif(
          { gcpProjectNumber: ` ${POOL_A.gcpProjectNumber} `, wifPoolId: 'SAM-Pool' },
          { gcpProjectId: 'gcp-b', serviceAccountEmail: 'sam@gcp-b.iam.gserviceaccount.com' }
        )
      )
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    expect(signIdentityToken).not.toHaveBeenCalled();
  });

  it('attack: a leading zero cannot alias A’s project number', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      exchange(
        user('user-b'),
        wif({ gcpProjectNumber: `0${POOL_A.gcpProjectNumber}`, wifPoolId: 'sam-pool' })
      )
    ).rejects.toBeInstanceOf(GcpWifPoolInvalidError);
    expect(signIdentityToken).not.toHaveBeenCalled();
  });

  it.each([
    ['provider id with a path', { wifProviderId: 'p/../../other-pool/providers/x' }],
    ['service account with a query', { serviceAccountEmail: 'sa@x.iam.gserviceaccount.com?a=b' }],
  ])('refuses a %s before signing', async (_name, overrides) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(exchange(user('user-a'), wif(POOL_A, overrides))).rejects.toBeInstanceOf(
      GcpWifPoolInvalidError
    );
    expect(signIdentityToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attack: a user credential cannot name the platform credential’s pool', async () => {
    await storePlatformRow('plat-1', wif(POOL_PLATFORM));

    await expect(exchange(user('user-b'), wif(POOL_PLATFORM))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Owner control: the installation still exchanges with its own pool.
    await expect(
      exchange(
        { cacheUserId: 'platform:user-b', poolOwner: { kind: 'platform' } },
        wif(POOL_PLATFORM)
      )
    ).resolves.toBe('sa-token');
  });

  it('attack: the platform credential cannot name a user’s pool', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));

    await expect(
      exchange({ cacheUserId: 'platform:user-b', poolOwner: { kind: 'platform' } }, wif(POOL_A))
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attack: a user credential cannot name another user’s deployment pool', async () => {
    sqlite
      .prepare(
        `INSERT INTO project_deployment_credentials (id, project_id, user_id, provider, gcp_project_id,
           gcp_project_number, service_account_email, wif_pool_id, wif_provider_id, created_at, updated_at)
         VALUES ('dep-a', 'proj-a', 'user-a', 'gcp', 'gcp-a', ?, 'deployer@a', 'sam-deploy-pool', 'p', ?, ?)`
      )
      .run(POOL_A.gcpProjectNumber, NOW, NOW);
    const deployPool = { gcpProjectNumber: POOL_A.gcpProjectNumber, wifPoolId: 'sam-deploy-pool' };

    await expect(exchange(user('user-b'), wif(deployPool))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    await expect(exchange(user('user-a'), wif(deployPool))).resolves.toBe('sa-token');
  });

  it('owner control: the same user’s user-level, project-scoped and composable copies share a pool', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    await storeLegacyRow('cred-a-proj', 'user-a', wif(POOL_A), 'proj-a');
    await storeCcRow('cc-a', 'user-a', JSON.stringify(wif(POOL_A)));

    await expect(
      exchange(
        { cacheUserId: 'project:proj-a:user-a', poolOwner: { kind: 'user', userId: 'user-a' } },
        wif(POOL_A),
        'proj-a'
      )
    ).resolves.toBe('sa-token');
    // Another project member's run uses A's project credential, so A owns the pool.
    await expect(
      exchange(
        { cacheUserId: 'project:proj-a:user-m', poolOwner: { kind: 'user', userId: 'user-a' } },
        wif(POOL_A),
        'proj-a'
      )
    ).resolves.toBe('sa-token');
  });

  it('a pool stays claimed after its credential is deleted or re-pointed (Google still trusts it)', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );

    // A re-saves their credential for a different pool (new IV): A now holds both pools.
    const repointed = await sealed(JSON.stringify(wif(POOL_B)));
    sqlite
      .prepare('UPDATE credentials SET encrypted_token = ?, iv = ? WHERE id = ?')
      .run(repointed.ciphertext, repointed.iv, 'cred-a');
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    await expect(exchange(user('user-b'), wif(POOL_B))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );

    // A disconnects entirely: the claims remain, because A's `pool/*` binding may remain too.
    sqlite.prepare('DELETE FROM credentials WHERE id = ?').run('cred-a');
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    // Owner control: A reconnects to the same pool.
    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');

    // An operator releases the claim once Google-side trust is gone; then B may use the pool.
    sqlite
      .prepare('DELETE FROM gcp_wif_pool_claims WHERE pool_key = ?')
      .run('111111111111/sam-pool');
    await expect(exchange(user('user-b'), wif(POOL_A))).resolves.toBe('sa-token');
    // B now holds the released pool.
    expect(
      sqlite
        .prepare('SELECT owner_user_id FROM gcp_wif_pool_claims WHERE pool_key = ?')
        .get('111111111111/sam-pool')
    ).toEqual({ owner_user_id: 'user-b' });
  });

  it('a live credential of another owner still blocks after a claim is released (symmetric check)', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    await storeLegacyRow('cred-b', 'user-b', wif(POOL_A));
    await expect(exchange(user('user-a'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    sqlite.prepare('DELETE FROM gcp_wif_pool_claims').run();
    // Both rows still exist and name the pool: neither owner may use it.
    await expect(exchange(user('user-a'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('platform and composable credentials claim their pools', async () => {
    await storePlatformRow('plat-1', wif(POOL_PLATFORM));
    await storeCcRow('cc-a', 'user-a', JSON.stringify(wif(POOL_A)));
    await expect(exchange(user('user-b'), wif(POOL_PLATFORM))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    expect(
      sqlite
        .prepare(
          'SELECT pool_key, owner_kind, owner_user_id FROM gcp_wif_pool_claims ORDER BY pool_key'
        )
        .all()
    ).toEqual([
      { pool_key: '111111111111/sam-pool', owner_kind: 'user', owner_user_id: 'user-a' },
      { pool_key: '222222222222/sam-pool', owner_kind: 'platform', owner_user_id: null },
    ]);
  });

  it('concurrent first claims of an unclaimed pool: exactly one owner wins', async () => {
    const results = await Promise.allSettled([
      assertGcpWifPayloadOwnership(
        env,
        JSON.stringify(wif(POOL_B)),
        { kind: 'user', userId: 'user-a' },
        't'
      ),
      assertGcpWifPayloadOwnership(
        env,
        JSON.stringify(wif(POOL_B)),
        { kind: 'user', userId: 'user-b' },
        't'
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
  });

  it('a bad row does not break the check for others (rule 41)', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    // Undecryptable ciphertext, a raw Hetzner token and a Scaleway JSON payload.
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('cc-broken', 'user-b', 'x', 'cloud-provider', 'bm90LWNpcGhlcnRleHQ=', 'AAAAAAAAAAAAAAAA', 1, ?, ?)`
      )
      .run(NOW, NOW);
    await storeCcRow('cc-hetzner', 'user-b', 'raw-hetzner-token');
    await storeCcRow('cc-scaleway', 'user-b', JSON.stringify({ secretKey: 's', projectId: 'p' }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );

    const rows = indexRows();
    expect(rows.filter((row) => row.source_id.startsWith('cc-'))).toEqual([
      expect.objectContaining({ source_id: 'cc-broken', pool_key: null }),
      expect.objectContaining({ source_id: 'cc-hetzner', pool_key: null }),
      expect.objectContaining({ source_id: 'cc-scaleway', pool_key: null }),
    ]);
    expect(rows.find((row) => row.source_id === 'cred-a')?.pool_key).toBe('111111111111/sam-pool');
    expect(errorLog.mock.calls.some(([line]) => String(line).includes('row_unreadable'))).toBe(
      true
    );
  });

  it('indexes more rows than one page in a single check, then reads the index without decrypting', async () => {
    // 230 non-GCP rows (more than nine pages at the default page size of 25) ahead of A's row.
    for (let i = 0; i < 230; i++) {
      await storeCcRow(`cc-other-${String(i).padStart(3, '0')}`, 'user-b', `token-${i}`);
    }
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));

    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
    expect(indexRows()).toHaveLength(231);

    const encryption = await import('../../../src/services/encryption');
    const decryptSpy = vi.spyOn(encryption, 'decrypt');
    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('fails closed when unindexed rows remain after the time budget', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    // More rows than one page (default 25), so a second page is needed after the deadline.
    for (let i = 0; i < 30; i++) {
      await storeCcRow(`cc-other-${String(i).padStart(2, '0')}`, 'user-b', `token-${i}`);
    }
    // Every clock reading is 20 s after the previous one, so whichever reading sets the
    // deadline (default budget 10 s), the next reading is already past it.
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 20_000));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(exchange(user('user-a'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolIndexUnavailableError
    );
    expect(signIdentityToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a credential whose project number cannot name a pool', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      exchange(user('user-a'), wif({ gcpProjectNumber: 'my-project-id', wifPoolId: 'sam-pool' }))
    ).rejects.toBeInstanceOf(GcpWifPoolInvalidError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('save time refuses a pool another owner uses', () => {
  it('POST /api/credentials: B naming A’s pool gets 409 and nothing is stored; A can save', async () => {
    auth.userId = 'user-a';
    const first = await postGcpCredential(wif(POOL_A));
    expect(first.status).toBe(201);
    // Owner control: A re-saves the same pool.
    expect((await postGcpCredential(wif(POOL_A))).status).toBe(200);

    auth.userId = 'user-b';
    const attack = await postGcpCredential(wif(POOL_A));
    expect(attack.status).toBe(409);
    expect(await attack.json()).toMatchObject({ error: 'GCP_WIF_POOL_OWNED_BY_ANOTHER_OWNER' });
    const bRows = sqlite
      .prepare(`SELECT count(*) AS n FROM credentials WHERE user_id = 'user-b'`)
      .get() as { n: number };
    expect(bRows.n).toBe(0);
    const bCc = sqlite
      .prepare(`SELECT count(*) AS n FROM cc_credentials WHERE owner_id = 'user-b'`)
      .get() as { n: number };
    expect(bCc.n).toBe(0);
  });

  it('POST /api/credentials: a user cannot save the platform credential’s pool', async () => {
    await storePlatformRow('plat-1', wif(POOL_PLATFORM));
    auth.userId = 'user-b';

    const attack = await postGcpCredential(wif(POOL_PLATFORM));
    expect(attack.status).toBe(409);
  });

  it('POST /api/cc/credentials: a composable cloud credential naming A’s pool gets 409', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    auth.userId = 'user-b';

    const attack = await testApp().request(
      '/api/cc/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'gcp',
          kind: 'cloud-provider',
          secret: { provider: 'gcp', token: JSON.stringify(wif(POOL_A)) },
        }),
      },
      env
    );
    expect(attack.status).toBe(409);

    // Owner control: A may store a composable copy of the same pool.
    auth.userId = 'user-a';
    const own = await testApp().request(
      '/api/cc/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'gcp', kind: 'cloud-provider', secret: wif(POOL_A) }),
      },
      env
    );
    expect(own.status).toBe(201);
  });

  it('project-scoped and platform payloads: refused for another owner, allowed for the owner', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    const projectPayload = serializeCredentialToken('gcp', {
      ...wif(POOL_A),
    } as unknown as Record<string, string>);

    // The project credential route checks the saving user as the owner.
    await expect(
      assertGcpWifPayloadOwnership(env, projectPayload, { kind: 'user', userId: 'user-a' }, 't')
    ).resolves.toBeUndefined();
    await expect(
      assertGcpWifPayloadOwnership(env, projectPayload, { kind: 'user', userId: 'user-b' }, 't')
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    // The admin platform route checks the installation as the owner.
    await expect(
      assertGcpWifPayloadOwnership(env, projectPayload, { kind: 'platform' }, 't')
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    // Non-GCP payloads are not affected.
    await expect(
      assertGcpWifPayloadOwnership(env, 'raw-hetzner-token', { kind: 'platform' }, 't')
    ).resolves.toBeUndefined();
  });

  it('the user GCP store refuses before writing anything', async () => {
    await storePlatformRow('plat-1', wif(POOL_PLATFORM));

    await expect(
      replaceUserGcpCredential(env, 'user-b', wif(POOL_PLATFORM))
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    const rows = sqlite.prepare('SELECT count(*) AS n FROM credentials').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('guided setup stops before changing anything in Google when the pool is taken', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    const google = vi.fn(async () =>
      Response.json({ projectNumber: POOL_A.gcpProjectNumber, projectId: 'gcp-a' })
    );
    vi.stubGlobal('fetch', google);
    const { assertGcpWifPoolOwnership } =
      await import('../../../src/services/gcp-wif-pool-ownership');

    await expect(
      runGcpSetup('oauth', 'gcp-a', 'us-central1-a', env, {
        userId: 'user-b',
        assertPoolAvailable: (pool) =>
          assertGcpWifPoolOwnership(env, pool, { kind: 'user', userId: 'user-b' }, 'gcp_setup'),
      })
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    // Only the project-number lookup ran: no API enablement, pool, provider or IAM change.
    expect(google).toHaveBeenCalledTimes(1);
  });
});

describe('index maintenance and cost', () => {
  it('retries an undecryptable row only after the retry window, then indexes it', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    // Encrypted under another key, as if the Worker's key were misconfigured when it was read.
    const otherKey = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
    const foreign = await encrypt(JSON.stringify(wif(POOL_B)), otherKey);
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('cc-other-key', 'user-a', 'x', 'cloud-provider', ?, ?, 1, ?, ?)`
      )
      .run(foreign.ciphertext, foreign.iv, NOW, NOW);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = () =>
      sqlite
        .prepare(
          `SELECT pool_key, unreadable FROM gcp_wif_pool_index WHERE source_id = 'cc-other-key'`
        )
        .get();

    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');
    expect(row()).toEqual({ pool_key: null, unreadable: 1 });

    // The key is fixed. Inside the retry window the row is not decrypted again.
    (env as { ENCRYPTION_KEY: string }).ENCRYPTION_KEY = otherKey;
    const encryption = await import('../../../src/services/encryption');
    const decryptSpy = vi.spyOn(encryption, 'decrypt');
    await expect(
      assertGcpWifPayloadOwnership(
        env,
        JSON.stringify(wif(POOL_A)),
        { kind: 'user', userId: 'user-a' },
        't'
      )
    ).resolves.toBeUndefined();
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(row()).toEqual({ pool_key: null, unreadable: 1 });

    // After the default 60-minute window it is read and its pool claimed for its owner.
    const later = Date.now() + 61 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await expect(
      assertGcpWifPayloadOwnership(
        env,
        JSON.stringify(wif(POOL_A)),
        { kind: 'user', userId: 'user-a' },
        't'
      )
    ).resolves.toBeUndefined();
    expect(row()).toEqual({ pool_key: '333333333333/sam-pool', unreadable: 0 });
    await expect(
      assertGcpWifPayloadOwnership(
        env,
        JSON.stringify(wif(POOL_B)),
        { kind: 'user', userId: 'user-b' },
        't'
      )
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
  });

  it('the probe reads only cloud credentials through the partial indexes', () => {
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${UNINDEXED_ROWS_SQL}`)
      .all(NOW, NOW, NOW, 25) as Array<{ detail: string }>;
    const details = plan.map((step) => step.detail);
    // No full scan of `credentials` (agent keys live there) or `cc_credentials`.
    expect(details.filter((d) => /^SCAN (c|cc)$/.test(d))).toEqual([]);
    expect(details.some((d) => d.includes('idx_credentials_gcp_cloud'))).toBe(true);
    expect(details.some((d) => d.includes('idx_cc_credentials_cloud'))).toBe(true);
  });
});

describe('the credential owner reaches the exchange through the real resolver', () => {
  it('a project member using another member’s project credential signs as, and is checked as, its owner', async () => {
    await storeLegacyRow('cred-a-proj', 'user-a', wif(POOL_A), 'proj-a');
    // A's pool is claimed by A (e.g. A also has a user-level credential for it).
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));

    const resolved = await createProviderForUser(
      drizzle(env.DATABASE, { schema }),
      'user-m',
      KEY,
      env,
      'gcp',
      'proj-a'
    );
    expect(resolved?.credentialSource).toBe('project');
    await expect(resolved!.provider.validateToken()).resolves.toBe(true);
    expect(signIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', projectId: 'proj-a' }),
      env
    );
  });

  it('the exact-credential path uses the stored row’s owner too', async () => {
    await storeLegacyRow('cred-a-proj', 'user-a', wif(POOL_A), 'proj-a');
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));

    const resolved = await createProviderForUser(
      drizzle(env.DATABASE, { schema }),
      'user-m',
      KEY,
      env,
      'gcp',
      'proj-a',
      {
        credentialSource: 'project',
        credentialReference: 'credentials:cred-a-proj',
        credentialVersion: Date.parse(NOW),
      }
    );
    await expect(resolved!.provider.validateToken()).resolves.toBe(true);
    expect(signIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', projectId: 'proj-a' }),
      env
    );
  });

  it('the exact path through a composable project credential uses its owner too', async () => {
    await storeCcRow('cc-a', 'user-a', JSON.stringify(wif(POOL_A)));
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id,
           settings_json, is_active, created_at, updated_at)
         VALUES ('cfg-a', 'user-a', 'GCP', 'compute', 'gcp', 'cc-a', NULL, 1, ?, ?)`
      )
      .run(NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO cc_attachments (id, configuration_id, consumer_kind, consumer_target, user_id,
           project_id, is_active, created_at, updated_at)
         VALUES ('att-a', 'cfg-a', 'compute', 'gcp', 'user-a', 'proj-a', 1, ?, ?)`
      )
      .run(NOW, NOW);

    const resolved = await createProviderForUser(
      drizzle(env.DATABASE, { schema }),
      'user-m',
      KEY,
      env,
      'gcp',
      'proj-a',
      {
        credentialSource: 'project',
        credentialReference: 'cc_credentials:cc-a',
        credentialVersion: Date.parse(NOW),
      }
    );
    await expect(resolved!.provider.validateToken()).resolves.toBe(true);
    expect(signIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', projectId: 'proj-a' }),
      env
    );
  });

  it('a user-level credential signs its owner’s id, which the user-scoped condition requires', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    const resolved = await createProviderForUser(
      drizzle(env.DATABASE, { schema }),
      'user-a',
      KEY,
      env,
      'gcp'
    );
    await expect(resolved!.provider.validateToken()).resolves.toBe(true);
    expect(signIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a' }),
      env
    );
  });
});

describe('the signed project_id cannot be chosen by the credential owner', () => {
  it('a user-level credential naming a SAM project id as its GCP project signs it namespaced', async () => {
    // B's own pool; B sets gcpProjectId to A's SAM project id, hoping a deployment provider
    // that trusts `project_id == 'proj-a'` accepts the token.
    const credential = wif(POOL_B, { gcpProjectId: 'proj-a' });
    await expect(exchange(user('user-b'), credential)).resolves.toBe('sa-token');
    expect(signIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-b', projectId: 'gcp-project:proj-a' }),
      env
    );
  });

  it('control: a token for a SAM project the caller acts for keeps that project id', async () => {
    await expect(
      exchange(
        { cacheUserId: 'project:proj-a:user-a', poolOwner: { kind: 'user', userId: 'user-a' } },
        wif(POOL_A),
        'proj-a'
      )
    ).resolves.toBe('sa-token');
    expect(signIdentityToken).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', projectId: 'proj-a' }),
      env
    );
  });
});

describe('the check fails closed on its own limits', () => {
  afterEach(async () => {
    const { __resetAdminSettingsCacheForTest } =
      await import('../../../src/services/admin-settings-resolution');
    __resetAdminSettingsCacheForTest();
  });

  it('refuses with 503 once indexing would pass the per-check D1 query budget, then resumes', async () => {
    const { __resetAdminSettingsCacheForTest } =
      await import('../../../src/services/admin-settings-resolution');
    __resetAdminSettingsCacheForTest();
    // Page size 5 costs at most 2 + 2 x 5 = 12 statements; a budget of 30 allows two pages.
    for (const [key, value] of [
      ['gcpWif.poolIndexPageSize', '5'],
      ['gcpWif.poolIndexMaxQueriesPerCheck', '30'],
    ]) {
      sqlite
        .prepare('INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run(key, value, NOW);
    }
    for (let i = 0; i < 40; i++) {
      await storeCcRow(`cc-other-${String(i).padStart(2, '0')}`, 'user-b', `token-${i}`);
    }
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(exchange(user('user-a'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolIndexUnavailableError
    );
    expect(signIdentityToken).not.toHaveBeenCalled();
    const indexed = () =>
      (sqlite.prepare('SELECT count(*) AS n FROM gcp_wif_pool_index').get() as { n: number }).n;
    const afterFirst = indexed();
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterFirst).toBeLessThan(41);

    // Progress is durable: later checks continue where the first stopped, then succeed.
    let attempts = 1;
    for (;;) {
      attempts += 1;
      try {
        await exchange(user('user-a'), wif(POOL_A));
        break;
      } catch (err) {
        expect(err).toBeInstanceOf(GcpWifPoolIndexUnavailableError);
        expect(attempts).toBeLessThan(10);
      }
    }
    expect(indexed()).toBe(41);
  });

  it.each([
    ['a short batch result', () => []],
    ['statements without row arrays', () => [{}, {}]],
  ])('refuses on %s instead of reading it as "no holders"', async (_name, shape) => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    const realBatch = env.DATABASE.batch.bind(env.DATABASE);
    vi.spyOn(env.DATABASE, 'batch').mockImplementationOnce(async () => shape() as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolIndexUnavailableError
    );
    expect(signIdentityToken).not.toHaveBeenCalled();
    // Liveness control: the real batch still refuses B as another owner.
    vi.mocked(env.DATABASE.batch).mockImplementation(realBatch);
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnedByAnotherOwnerError
    );
  });
});

describe('review round 3: unresolved rows, budgets, deletes and deployments', () => {
  afterEach(async () => {
    const { __resetAdminSettingsCacheForTest } =
      await import('../../../src/services/admin-settings-resolution');
    __resetAdminSettingsCacheForTest();
  });

  async function setSetting(key: string, value: string) {
    const { __resetAdminSettingsCacheForTest } =
      await import('../../../src/services/admin-settings-resolution');
    __resetAdminSettingsCacheForTest();
    sqlite
      .prepare('INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, NOW);
  }

  async function storeUnreadableCc(
    id: string,
    ownerId: string,
    options: { gcpConfiguration: boolean } = { gcpConfiguration: true }
  ) {
    const otherKey = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
    const foreign = await encrypt(JSON.stringify(wif(POOL_A)), otherKey);
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES (?, ?, 'x', 'cloud-provider', ?, ?, 1, ?, ?)`
      )
      .run(id, ownerId, foreign.ciphertext, foreign.iv, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target, credential_id,
           settings_json, is_active, created_at, updated_at)
         VALUES (?, ?, 'c', 'compute', ?, ?, NULL, 1, ?, ?)`
      )
      .run(`cfg-${id}`, ownerId, options.gcpConfiguration ? 'gcp' : 'hetzner', id, NOW, NOW);
  }

  it('withholds a NEW first claim while another owner’s credential is unreadable', async () => {
    // A's credential for POOL_A cannot be decrypted (for example a key misconfiguration).
    await storeUnreadableCc('cc-a-unreadable', 'user-a');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // B names POOL_A with a credential SAM has not stored: a new first claim.
    await expect(exchange(user('user-b'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolOwnershipUnresolvedError
    );
    expect(signIdentityToken).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT count(*) AS n FROM gcp_wif_pool_claims').get()).toEqual({
      n: 0,
    });
    // Control: an unreadable credential of another provider does not withhold GCP claims.
    sqlite.prepare('DELETE FROM cc_configurations').run();
    sqlite.prepare('DELETE FROM cc_credentials').run();
    await storeUnreadableCc('cc-a-hetzner', 'user-a', { gcpConfiguration: false });
    await expect(exchange(user('user-b'), wif(POOL_A))).resolves.toBe('sa-token');
    sqlite.prepare('DELETE FROM gcp_wif_pool_claims').run();
    sqlite.prepare('DELETE FROM cc_configurations').run();
    sqlite.prepare('DELETE FROM cc_credentials').run();
    await storeUnreadableCc('cc-a-unreadable', 'user-a');
    // Owner control: the unreadable row's own owner is not blocked by it.
    await expect(exchange(user('user-a'), wif(POOL_B))).resolves.toBe('sa-token');
    await expect(exchange(user('user-a'), wif(POOL_B))).resolves.toBe('sa-token');
  });

  it('never issues more statements than the per-check budget, even on the first page', async () => {
    await setSetting('gcpWif.poolIndexPageSize', '50');
    await setSetting('gcpWif.poolIndexMaxQueriesPerCheck', '6');
    for (let i = 0; i < 3; i++) await storeCcRow(`cc-other-${i}`, 'user-b', `token-${i}`);
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const batch = vi.spyOn(env.DATABASE, 'batch');

    await expect(exchange(user('user-a'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolIndexUnavailableError
    );
    const statements = batch.mock.calls.reduce((sum, [list]) => sum + list.length, 0);
    expect(statements).toBeLessThanOrEqual(6);
    expect(
      (sqlite.prepare('SELECT count(*) AS n FROM gcp_wif_pool_index').get() as { n: number }).n
    ).toBe(1);
  });

  it('a rejected probe becomes the retryable 503, not an upstream error', async () => {
    vi.spyOn(env.DATABASE, 'batch').mockRejectedValueOnce(new Error('D1_ERROR: overloaded'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(exchange(user('user-a'), wif(POOL_A))).rejects.toBeInstanceOf(
      GcpWifPoolIndexUnavailableError
    );
    // Liveness control: the next check succeeds.
    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');
  });

  it('a disconnect before any other check still leaves the pool claimed', async () => {
    // A connected before this release: the row exists, nothing is indexed or claimed yet.
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    auth.userId = 'user-a';
    const removed = await testApp().request('/api/credentials/gcp', { method: 'DELETE' }, env);
    expect(removed.status).toBe(200);
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM credentials WHERE user_id = ?').get('user-a')
    ).toEqual({ n: 0 });

    auth.userId = 'user-b';
    const attack = await postGcpCredential(wif(POOL_A));
    expect(attack.status).toBe(409);
    // Control: B can still save a pool nobody holds.
    expect((await postGcpCredential(wif(POOL_B))).status).toBe(201);
  });

  it('the production error handler keeps unrelated failures distinct', async () => {
    auth.userId = 'user-b';
    const invalid = await testApp().request(
      '/api/credentials',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gcp', gcpProjectId: 'x' }),
      },
      env
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).not.toMatchObject({
      error: 'GCP_WIF_POOL_OWNED_BY_ANOTHER_OWNER',
    });
  });

  it('migration 0262 claims existing deployment pools with one owner, and none with two', () => {
    const deployment = (id: string, userId: string, projectNumber: string, pool: string) =>
      sqlite
        .prepare(
          `INSERT INTO project_deployment_credentials (id, project_id, user_id, provider, gcp_project_id,
             gcp_project_number, service_account_email, wif_pool_id, wif_provider_id, created_at, updated_at)
           VALUES (?, ?, ?, 'gcp', 'gcp-x', ?, 'deployer@x', ?, 'p', ?, ?)`
        )
        .run(id, `proj-${id}`, userId, projectNumber, pool, NOW, NOW);
    sqlite.pragma('foreign_keys = OFF');
    deployment('dep-1', 'user-a', '444444444444', 'Sam-Deploy-Pool');
    deployment('dep-2', 'user-a', '555555555555', 'sam-deploy-pool');
    deployment('dep-3', 'user-b', '555555555555', 'sam-deploy-pool');
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0262_gcp_wif_pool_index.sql', import.meta.url),
        'utf8'
      )
    );
    expect(
      sqlite
        .prepare('SELECT pool_key, owner_user_id FROM gcp_wif_pool_claims ORDER BY pool_key')
        .all()
    ).toEqual([{ pool_key: '444444444444/sam-deploy-pool', owner_user_id: 'user-a' }]);
  });

  it('deployment setup stops before changing anything in Google when the pool is taken', async () => {
    await storeLegacyRow(
      'cred-a',
      'user-a',
      wif({ gcpProjectNumber: POOL_A.gcpProjectNumber, wifPoolId: 'sam-deploy-pool' })
    );
    const google = vi.fn(async () =>
      Response.json({ projectNumber: POOL_A.gcpProjectNumber, projectId: 'gcp-a' })
    );
    vi.stubGlobal('fetch', google);
    const { assertGcpWifPoolOwnership } =
      await import('../../../src/services/gcp-wif-pool-ownership');

    await expect(
      runGcpDeploySetup('oauth', 'gcp-a', env, 'proj-b', {
        assertPoolAvailable: (pool) =>
          assertGcpWifPoolOwnership(
            env,
            pool,
            { kind: 'user', userId: 'user-b' },
            'gcp_deploy_setup'
          ),
      })
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
    expect(google).toHaveBeenCalledTimes(1);
  });
});

describe('an unreadable row does not refuse stored credentials (rule 41)', () => {
  it('claims every stored readable credential in the page, before and after the unreadable one', async () => {
    const otherKey = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
    // Insert order puts the unreadable row between two readable ones of other owners.
    await storeCcRow('cc-1-a', 'user-a', JSON.stringify(wif(POOL_A)));
    const bad = await encrypt(JSON.stringify(wif(POOL_PLATFORM)), otherKey);
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('cc-2-m', 'user-m', 'x', 'cloud-provider', ?, ?, 1, ?, ?)`
      )
      .run(bad.ciphertext, bad.iv, NOW, NOW);
    await storeCcRow('cc-3-b', 'user-b', JSON.stringify(wif(POOL_B)));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Both stored owners exchange normally despite user-m's unreadable row.
    await expect(exchange(user('user-a'), wif(POOL_A))).resolves.toBe('sa-token');
    await expect(exchange(user('user-b'), wif(POOL_B))).resolves.toBe('sa-token');
    expect(
      sqlite
        .prepare('SELECT pool_key, owner_user_id FROM gcp_wif_pool_claims ORDER BY pool_key')
        .all()
    ).toEqual([
      { pool_key: '111111111111/sam-pool', owner_user_id: 'user-a' },
      { pool_key: '333333333333/sam-pool', owner_user_id: 'user-b' },
    ]);
  });

  it('a disconnect with another owner’s unreadable row present still leaves the pool claimed', async () => {
    const otherKey = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
    const bad = await encrypt(JSON.stringify(wif(POOL_PLATFORM)), otherKey);
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('cc-m-bad', 'user-m', 'x', 'cloud-provider', ?, ?, 1, ?, ?)`
      )
      .run(bad.ciphertext, bad.iv, NOW, NOW);
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    auth.userId = 'user-a';
    expect(
      (await testApp().request('/api/credentials/gcp', { method: 'DELETE' }, env)).status
    ).toBe(200);

    auth.userId = 'user-b';
    expect((await postGcpCredential(wif(POOL_A))).status).toBe(409);
  });

  it('replacing a WIF connection with a service-account key keeps the old pool claimed', async () => {
    await storeLegacyRow('cred-a', 'user-a', wif(POOL_A));
    await replaceUserGcpCredential(env, 'user-a', {
      version: GCP_CREDENTIAL_VERSION,
      provider: 'gcp',
      authType: 'service-account-key',
      gcpProjectId: 'gcp-a',
      serviceAccountEmail: 'sa@gcp-a.iam.gserviceaccount.com',
      privateKeyId: 'kid',
      privateKey: 'not-a-real-key',
      defaultZone: 'us-central1-a',
    });
    await expect(
      assertGcpWifPayloadOwnership(
        env,
        JSON.stringify(wif(POOL_A)),
        { kind: 'user', userId: 'user-b' },
        't'
      )
    ).rejects.toBeInstanceOf(GcpWifPoolOwnedByAnotherOwnerError);
  });
});

describe('deletes reconcile only for credentials that can name a GCP pool', () => {
  it('an agent-key delete never waits on pool reconciliation', async () => {
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, is_active, created_at, updated_at)
         VALUES ('cc-agent', 'user-a', 'claude', 'api-key', 'x', 'y', 1, ?, ?)`
      )
      .run(NOW, NOW);
    // Pool reconciliation would fail closed (503) if it ran.
    vi.spyOn(env.DATABASE, 'batch').mockRejectedValue(new Error('D1 unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    auth.userId = 'user-a';

    const res = await testApp().request('/api/cc/credentials/cc-agent', { method: 'DELETE' }, env);
    expect(res.status).toBe(200);
  });

  it('control: a cloud-provider composable delete still reconciles first (and refuses while it cannot)', async () => {
    await storeCcRow('cc-cloud', 'user-a', JSON.stringify(wif(POOL_A)));
    vi.spyOn(env.DATABASE, 'batch').mockRejectedValue(new Error('D1 unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    auth.userId = 'user-a';

    const res = await testApp().request('/api/cc/credentials/cc-cloud', { method: 'DELETE' }, env);
    expect(res.status).toBe(503);
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM cc_credentials WHERE id = 'cc-cloud'").get()
    ).toEqual({ n: 1 });
  });
});
