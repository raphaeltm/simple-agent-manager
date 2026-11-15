import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  decryptToken,
  encryptToken,
  hmacApiToken,
} from '../deploy/bootstrap-installation-credentials';
import {
  bootstrapCloudCredentialId,
  bootstrapInstallation,
  bootstrapSmokeTokenId,
  bootstrapUsers,
  type D1Like,
  deriveAgentSignInTrust,
  primaryTestAccountIds,
} from '../deploy/bootstrap-staging-installation';
import { resolveInstallationZone } from '../deploy/resolve-installation-zone.mjs';
import {
  credentialEnvironmentFor,
  resolveInstallation,
  SECONDARY_CREDENTIAL_ENVIRONMENTS,
  SECONDARY_INSTALLATIONS,
  workflowTargetFor,
} from '../deploy/staging-installations.mjs';
import { resolveResourceNames } from '../deploy/workflow-resource-names.mjs';

const MIGRATIONS_DIR = new URL('../../apps/api/src/db/migrations/', import.meta.url);

/** A database built from the real D1 migration chain, so every column and index is production's. */
function migratedDatabase(): { db: DatabaseSync; d1: D1Like } {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
  }
  const d1: D1Like = {
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
    run: async (sql: string, params: unknown[] = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
  };
  return { db, d1 };
}

function key(seed: number): string {
  return Buffer.alloc(32, seed).toString('base64');
}

const SOURCE_KEY = key(1);
const TARGET_KEY = key(2);
const PRIMARY = { baseDomain: 'sammy.party', prefix: 'sam', stack: 'staging' };

describe('resolveInstallation', () => {
  it('passes the environment through as its own primary installation', () => {
    expect(
      resolveInstallation({ environment: 'staging', installation: '', primary: PRIMARY })
    ).toEqual({
      installation: 'staging',
      secondary: false,
    });
    expect(
      resolveInstallation({
        environment: 'production',
        installation: 'production',
        primary: PRIMARY,
      })
    ).toMatchObject({ secondary: false });
  });

  it('resolves the registered second staging with the staging credentials', () => {
    const result = resolveInstallation({
      environment: 'staging',
      installation: 'staging2',
      primary: PRIMARY,
    });
    expect(result).toMatchObject({
      installation: 'staging2',
      secondary: true,
      entry: { baseDomain: 'sammy2.party', resourcePrefix: 'sam2', stack: 'staging2' },
    });
  });

  it.each([
    ['production credentials', 'production', 'staging2'],
    ['production alias as environment', 'prod', 'staging2'],
    ['production-like installation name', 'staging', 'prod2'],
    ['unregistered installation', 'staging', 'staging9'],
    ['wrong credential environment', 'development', 'staging2'],
    ['uppercase name', 'staging', 'Staging2'],
    ['injection attempt', 'staging', 'staging2\nname=x'],
  ])('refuses %s', (_label, environment, installation) => {
    expect(() => resolveInstallation({ environment, installation, primary: PRIMARY })).toThrow();
  });

  it.each([
    ['domain', { ...PRIMARY, baseDomain: 'SAMMY2.party' }],
    ['prefix', { ...PRIMARY, prefix: 'sam2' }],
    ['stack', { ...PRIMARY, stack: 'staging2' }],
  ])('refuses a secondary that would reuse the primary %s', (_label, primary) => {
    expect(() =>
      resolveInstallation({ environment: 'staging', installation: 'staging2', primary })
    ).toThrow(/reuse the primary/);
  });

  it('registers no installation that could reach production', () => {
    const domains = new Set<string>();
    expect(SECONDARY_CREDENTIAL_ENVIRONMENTS).toEqual(['staging']);
    for (const [name, entry] of Object.entries(SECONDARY_INSTALLATIONS)) {
      expect(SECONDARY_CREDENTIAL_ENVIRONMENTS).toContain(entry.credentialEnvironment);
      for (const value of [name, entry.credentialEnvironment, entry.stack, entry.resourcePrefix]) {
        expect(value).not.toMatch(/prod/i);
      }
      expect(domains.has(entry.baseDomain)).toBe(false);
      domains.add(entry.baseDomain);
    }
    expect(domains.size).toBeGreaterThan(0);
  });
});

describe('resolveResourceNames with an installation', () => {
  const stagingEnv = {
    DEPLOY_ENVIRONMENT: 'staging',
    RESOURCE_PREFIX: 'sam',
    BASE_DOMAIN: 'sammy.party',
  };

  it('keeps the primary staging names unchanged', () => {
    const names = resolveResourceNames(stagingEnv, 'deploy');
    expect(names).toMatchObject({
      environment: 'staging',
      installation: 'staging',
      credential_environment: 'staging',
      secondary: 'false',
      stack: 'staging',
      api_worker: 'sam-api-staging',
      pulumi_state_bucket: 'sam-pulumi-state',
    });
    expect(names).not.toHaveProperty('zone_name');
  });

  it('gives staging2 its own names and the primary state bucket', () => {
    const names = resolveResourceNames({ ...stagingEnv, INSTALLATION: 'staging2' }, 'deploy');
    expect(names).toMatchObject({
      environment: 'staging2',
      installation: 'staging2',
      credential_environment: 'staging',
      secondary: 'true',
      stack: 'staging2',
      prefix: 'sam2',
      base_domain: 'sammy2.party',
      zone_name: 'sammy2.party',
      api_worker: 'sam2-api-staging2',
      tail_worker: 'sam2-tail-worker-staging2',
      web_pages_project: 'sam2-web-staging2',
      ai_gateway: 'sam2',
      analytics_dataset: 'sam2_analytics',
      pulumi_state_bucket: 'sam-pulumi-state',
      primary_stack: 'staging',
      primary_prefix: 'sam',
    });
    for (const value of Object.values(names)) {
      expect(value).not.toMatch(/^sam-.*staging$/);
    }
  });

  it('refuses staging2 when the job runs with production credentials', () => {
    expect(() =>
      resolveResourceNames(
        {
          DEPLOY_ENVIRONMENT: 'production',
          BASE_DOMAIN: 'simple-agent-manager.org',
          INSTALLATION: 'staging2',
        },
        'teardown'
      )
    ).toThrow(/production/);
  });
});

describe('deriveAgentSignInTrust', () => {
  const source = JSON.stringify({
    issuer: 'https://api.example.org/oidc',
    allowedSources: [{ projectId: 'P', userId: 'U' }],
    allowedTargets: ['primary-user'],
    sessionTtlSeconds: 3600,
  });

  it('keeps issuer, sources and limits and retargets the users', () => {
    const derived = JSON.parse(deriveAgentSignInTrust(source, ['a', 'b'])!);
    expect(derived).toEqual({
      issuer: 'https://api.example.org/oidc',
      allowedSources: [{ projectId: 'P', userId: 'U' }],
      allowedTargets: ['a', 'b'],
      sessionTtlSeconds: 3600,
    });
  });

  it('stays off when the primary has no trust, and rejects malformed trust', () => {
    expect(deriveAgentSignInTrust(undefined, ['a'])).toBeNull();
    expect(deriveAgentSignInTrust('  ', ['a'])).toBeNull();
    expect(() => deriveAgentSignInTrust('{', ['a'])).toThrow(/not valid JSON/);
    expect(() => deriveAgentSignInTrust('[]', ['a'])).toThrow(/not a JSON object/);
    expect(() => deriveAgentSignInTrust(source, [])).toThrow();
  });
});

describe('bootstrapInstallation on the real migration chain', () => {
  let target: ReturnType<typeof migratedDatabase>;
  let source: ReturnType<typeof migratedDatabase>;
  const logs: string[] = [];

  async function seedSourceCredential(input: {
    table: 'platform_credentials' | 'credentials';
    id: string;
    provider: string;
    plaintext: string;
    keyBase64?: string;
    updatedAt?: string;
  }): Promise<void> {
    const sealed = await encryptToken(input.plaintext, input.keyBase64 ?? SOURCE_KEY);
    const at = input.updatedAt ?? '2026-11-01T00:00:00.000Z';
    if (input.table === 'platform_credentials') {
      source.db
        .prepare(
          `INSERT INTO platform_credentials (id, credential_type, provider, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_at)
           VALUES (?, 'cloud-provider', ?, 'x', ?, ?, 1, 'owner', ?, ?)`
        )
        .run(input.id, input.provider, sealed.ciphertext, sealed.iv, at, at);
    } else {
      source.db
        .prepare(
          `INSERT INTO credentials (id, user_id, provider, encrypted_token, iv, created_at, updated_at, credential_type, credential_kind, is_active)
           VALUES (?, 'owner', ?, ?, ?, ?, ?, 'cloud-provider', 'api-key', 1)`
        )
        .run(input.id, input.provider, sealed.ciphertext, sealed.iv, at, at);
    }
  }

  const gcpKey = JSON.stringify({
    version: 1,
    provider: 'gcp',
    authType: 'service-account-key',
    gcpProjectId: 'p',
    serviceAccountEmail: 'sa@p.iam.gserviceaccount.com',
    privateKeyId: 'k',
    privateKey: 'PRIVATE',
    defaultZone: 'us-central1-a',
  });
  const gcpWif = JSON.stringify({ version: 1, provider: 'gcp', authType: 'workload-identity' });

  function run(overrides: Partial<Parameters<typeof bootstrapInstallation>[0]> = {}) {
    return bootstrapInstallation({
      installation: 'staging2',
      environment: 'staging',
      baseDomain: 'sammy2.party',
      target: target.d1,
      source: source.d1,
      targetCredentialKey: TARGET_KEY,
      targetEncryptionKey: TARGET_KEY,
      sourceCredentialKey: SOURCE_KEY,
      smokeTestToken: 'sam_smoke_token_value',
      primaryTestAccountIds: ['owner'],
      now: new Date('2026-11-15T20:00:00.000Z'),
      log: (message) => logs.push(message),
      ...overrides,
    });
  }

  function count(db: DatabaseSync, table: string): number {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  beforeEach(() => {
    target = migratedDatabase();
    source = migratedDatabase();
    logs.length = 0;
    source.db
      .prepare(
        `INSERT INTO users (id, email, role, status, created_at, updated_at) VALUES ('owner', 'o@x', 'superadmin', 'active', 1, 1)`
      )
      .run();
  });

  it('seeds users, a GCP service-account credential and the smoke token, and closes setup', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    await seedSourceCredential({
      table: 'credentials',
      id: 'gcp-wif',
      provider: 'gcp',
      plaintext: gcpWif,
      updatedAt: '2026-11-14T00:00:00.000Z',
    });
    await seedSourceCredential({
      table: 'credentials',
      id: 'gcp-sa',
      provider: 'gcp',
      plaintext: gcpKey,
    });

    const report = await run();

    expect(report.cloudCredential).toMatchObject({
      provider: 'gcp',
      authType: 'service-account-key',
      sourceTable: 'credentials',
      sourceId: 'gcp-sa',
      targetId: 'staging2-bootstrap-cloud',
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(logs.join('\n')).not.toContain('PRIVATE');
    expect(logs.join('\n')).toContain(
      'skip credentials gcp-wif (gcp): auth type workload-identity is not portable'
    );

    const users = target.db
      .prepare(`SELECT id, email, role, status FROM users WHERE status != 'system' ORDER BY id`)
      .all();
    expect(users).toEqual([
      {
        id: 'staging2-agent-admin',
        email: 'agent-admin@sammy2.party',
        role: 'superadmin',
        status: 'active',
      },
      {
        id: 'staging2-agent-user',
        email: 'agent-user@sammy2.party',
        role: 'user',
        status: 'active',
      },
    ]);
    // The query isSetupCompleted() uses to close first-run setup.
    const owner = target.db
      .prepare(
        `SELECT id FROM users WHERE role = 'superadmin' AND status = 'active' AND id != 'system_anonymous_trials' LIMIT 1`
      )
      .get();
    expect(owner).toEqual({ id: 'staging2-agent-admin' });

    const credential = target.db
      .prepare(
        `SELECT provider, credential_type, is_enabled, encrypted_token, iv FROM platform_credentials WHERE id = ?`
      )
      .get(bootstrapCloudCredentialId('staging2')) as {
      provider: string;
      credential_type: string;
      is_enabled: number;
      encrypted_token: string;
      iv: string;
    };
    expect(credential).toMatchObject({
      provider: 'gcp',
      credential_type: 'cloud-provider',
      is_enabled: 1,
    });
    expect(await decryptToken(credential.encrypted_token, credential.iv, TARGET_KEY)).toBe(gcpKey);
    await expect(
      decryptToken(credential.encrypted_token, credential.iv, SOURCE_KEY)
    ).rejects.toThrow();

    const token = target.db
      .prepare('SELECT user_id, token_hash, revoked_at FROM smoke_test_tokens WHERE id = ?')
      .get(bootstrapSmokeTokenId('staging2'));
    expect(token).toEqual({
      user_id: 'staging2-agent-admin',
      token_hash: await hmacApiToken('sam_smoke_token_value', TARGET_KEY),
      revoked_at: null,
    });
  });

  it('copies the primary platform agent keys, one per agent type, re-encrypted', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    const add = async (
      id: string,
      agentType: string,
      plaintext: string,
      keyBase64 = SOURCE_KEY,
      at = '2026-11-01'
    ) => {
      const sealed = await encryptToken(plaintext, keyBase64);
      source.db
        .prepare(
          `INSERT INTO platform_credentials (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv, is_enabled, created_by, created_at, updated_at)
           VALUES (?, 'agent-api-key', NULL, ?, 'api-key', 'k', ?, ?, 1, 'owner', ?, ?)`
        )
        .run(id, agentType, sealed.ciphertext, sealed.iv, at, at);
    };
    await add('claude-old', 'claude-code', 'OLD-KEY', SOURCE_KEY, '2026-01-01');
    await add('claude-new', 'claude-code', 'NEW-KEY', SOURCE_KEY, '2026-11-10');
    await add('codex-bad', 'openai-codex', 'X', key(9));
    const oauth = await encryptToken('ROTATING', SOURCE_KEY);
    source.db
      .prepare(
        `INSERT INTO platform_credentials (id, credential_type, provider, agent_type, credential_kind, label, encrypted_token, iv, is_enabled, created_by)
         VALUES ('codex-oauth', 'agent-api-key', NULL, 'openai-codex', 'oauth-token', 'k', ?, ?, 1, 'owner')`
      )
      .run(oauth.ciphertext, oauth.iv);

    const report = await run();

    expect(report.agentKeys).toEqual(['claude-code']);
    expect(JSON.stringify(report) + logs.join('\n')).not.toContain('NEW-KEY');
    const row = target.db
      .prepare(
        `SELECT agent_type, credential_type, encrypted_token, iv FROM platform_credentials WHERE id = 'staging2-bootstrap-agent-claude-code'`
      )
      .get() as {
      agent_type: string;
      credential_type: string;
      encrypted_token: string;
      iv: string;
    };
    expect(row).toMatchObject({ agent_type: 'claude-code', credential_type: 'agent-api-key' });
    expect(await decryptToken(row.encrypted_token, row.iv, TARGET_KEY)).toBe('NEW-KEY');
    expect(logs.join('\n')).toMatch(/skip agent key codex-bad \(openai-codex\): cannot decrypt/);
    expect(logs.join('\n')).not.toContain('codex-oauth');

    await run();
    expect(
      target.db
        .prepare(
          `SELECT count(*) AS n FROM platform_credentials WHERE credential_type = 'agent-api-key'`
        )
        .get()
    ).toEqual({ n: 1 });
  });

  it('is idempotent and keeps changes an admin made on the installation', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    await run();
    target.db
      .prepare(
        `UPDATE users SET role = 'user', status = 'suspended' WHERE id = 'staging2-agent-admin'`
      )
      .run();
    target.db.prepare(`UPDATE smoke_test_tokens SET revoked_at = 5`).run();
    target.db.prepare(`UPDATE platform_credentials SET is_enabled = 0`).run();
    const before = ['users', 'platform_credentials', 'smoke_test_tokens'].map((t) =>
      count(target.db, t)
    );
    const oldIv = (target.db.prepare('SELECT iv FROM platform_credentials').get() as { iv: string })
      .iv;

    await run();

    expect(
      ['users', 'platform_credentials', 'smoke_test_tokens'].map((t) => count(target.db, t))
    ).toEqual(before);
    expect(
      target.db.prepare(`SELECT role, status FROM users WHERE id = 'staging2-agent-admin'`).get()
    ).toEqual({ role: 'user', status: 'suspended' });
    expect(target.db.prepare('SELECT revoked_at FROM smoke_test_tokens').get()).toEqual({
      revoked_at: 5,
    });
    const credential = target.db
      .prepare('SELECT is_enabled, iv, encrypted_token FROM platform_credentials')
      .get() as { is_enabled: number; iv: string; encrypted_token: string };
    expect(credential.is_enabled).toBe(0);
    // The ciphertext still follows the primary's credential.
    expect(credential.iv).not.toBe(oldIv);
    expect(await decryptToken(credential.encrypted_token, credential.iv, TARGET_KEY)).toBe(
      'hetzner-token'
    );
  });

  it("never copies the GCP credential of an account that is not one of the primary's test accounts", async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    await seedSourceCredential({
      table: 'credentials',
      id: 'gcp-sa',
      provider: 'gcp',
      plaintext: gcpKey,
    });

    expect(
      (await run({ primaryTestAccountIds: ['someone-else-123'] })).cloudCredential
    ).toMatchObject({ provider: 'hetzner', sourceId: 'hz' });
    expect((await run({ primaryTestAccountIds: [] })).cloudCredential).toMatchObject({
      provider: 'hetzner',
    });
    // Control: the same row is chosen when its owner is a designated test account.
    expect((await run()).cloudCredential).toMatchObject({ provider: 'gcp', sourceId: 'gcp-sa' });
  });

  it('reads test account IDs from the primary trust, ignoring emails and the wildcard', () => {
    expect(
      primaryTestAccountIds(
        JSON.stringify({ allowedTargets: ['toWzGjNW3IyUkCVItRQv3qSn0wI8c22y', 'a@b.c', '*', 7] })
      )
    ).toEqual(['toWzGjNW3IyUkCVItRQv3qSn0wI8c22y']);
    expect(primaryTestAccountIds(JSON.stringify({ allowedTargets: '*' }))).toEqual([]);
    expect(primaryTestAccountIds('{')).toEqual([]);
    expect(primaryTestAccountIds(undefined)).toEqual([]);
  });

  it('leaves credentials an admin added by hand alone', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    await run();
    target.db
      .prepare(
        `INSERT INTO platform_credentials (id, credential_type, provider, label, encrypted_token, iv, is_enabled, created_by)
         VALUES ('manual', 'cloud-provider', 'gcp', 'manual', 'c', 'i', 1, 'staging2-agent-admin')`
      )
      .run();
    await run();
    expect(
      target.db
        .prepare(`SELECT encrypted_token FROM platform_credentials WHERE id = 'manual'`)
        .get()
    ).toEqual({
      encrypted_token: 'c',
    });
  });

  it('prefers a platform GCP credential, and skips a row it cannot decrypt', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'gcp-bad',
      provider: 'gcp',
      plaintext: gcpKey,
      keyBase64: key(9),
      updatedAt: '2026-11-15T00:00:00.000Z',
    });
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'gcp-good',
      provider: 'gcp',
      plaintext: gcpKey,
    });
    await seedSourceCredential({
      table: 'credentials',
      id: 'gcp-user',
      provider: 'gcp',
      plaintext: gcpKey,
      updatedAt: '2026-11-16T00:00:00.000Z',
    });

    const report = await run();

    expect(report.cloudCredential).toMatchObject({
      sourceTable: 'platform_credentials',
      sourceId: 'gcp-good',
    });
    expect(logs.join('\n')).toMatch(/skip platform_credentials gcp-bad \(gcp\): cannot decrypt/);
  });

  it('falls back to Hetzner when no GCP credential is portable', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'gcp-wif',
      provider: 'gcp',
      plaintext: gcpWif,
    });
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    expect((await run()).cloudCredential).toMatchObject({ provider: 'hetzner', sourceId: 'hz' });
  });

  it('fails when the primary has no usable cloud credential', async () => {
    await expect(run()).rejects.toThrow(/No portable cloud credential/);
  });

  it('skips the smoke token when none is configured', async () => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    expect((await run({ smokeTestToken: undefined })).smokeToken).toBe('skipped');
    expect(count(target.db, 'smoke_test_tokens')).toBe(0);
  });

  it.each([
    ['production environment', { environment: 'production' }],
    ['production-like installation', { installation: 'prod' }],
    ['the primary staging itself', { installation: 'staging' }],
    ['an unregistered installation', { installation: 'staging9' }],
    ['a domain other than the registered one', { baseDomain: 'simple-agent-manager.org' }],
    ['another environment', { environment: 'development' }],
  ])('refuses %s before writing anything', async (_label, overrides) => {
    await seedSourceCredential({
      table: 'platform_credentials',
      id: 'hz',
      provider: 'hetzner',
      plaintext: 'hetzner-token',
    });
    await expect(run(overrides)).rejects.toThrow();
    expect(count(target.db, 'users')).toBe(1); // the migration-seeded system user only
    expect(count(target.db, 'platform_credentials')).toBe(0);
  });

  it('names the users the derived trust allows', () => {
    expect(bootstrapUsers('staging2', 'sammy2.party').map((u) => u.id)).toEqual([
      'staging2-agent-admin',
      'staging2-agent-user',
    ]);
  });
});

describe('credentialEnvironmentFor', () => {
  it('maps staging2 to the staging credentials and leaves primaries alone', () => {
    expect(credentialEnvironmentFor('staging2')).toBe('staging');
    expect(credentialEnvironmentFor('staging')).toBe('staging');
    expect(credentialEnvironmentFor('production')).toBe('production');
  });

  it.each(['', 'Staging2', 'staging2\nx=y', '../staging'])('rejects %j', (value) => {
    expect(() => credentialEnvironmentFor(value)).toThrow();
  });
});

describe('workflowTargetFor (deploy-staging.yml)', () => {
  it('maps staging2 to the staging credentials and its own domain', () => {
    expect(workflowTargetFor('staging2', 'sammy.party')).toEqual({
      credential_environment: 'staging',
      installation: 'staging2',
      base_domain: 'sammy2.party',
    });
  });

  it('leaves the primary on its own environment and domain', () => {
    expect(workflowTargetFor('staging', 'sammy.party')).toEqual({
      credential_environment: 'staging',
      installation: '',
      base_domain: 'sammy.party',
    });
  });

  it.each(['production', 'prod', 'Production', 'preprod'])('refuses %s', (name) => {
    expect(() => workflowTargetFor(name, 'example.org')).toThrow();
  });

  it('needs a domain for a primary', () => {
    expect(() => workflowTargetFor('staging', undefined)).toThrow(/No domain/);
  });
});

describe('resolveInstallationZone', () => {
  const accountId = 'acct';
  function fakeCloudflare(zones: unknown[], subdomain: unknown = { subdomain: 'account-sub' }) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const result = url.includes('/workers/subdomain') ? subdomain : zones;
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('returns the one active zone with that exact name in this account', async () => {
    const { fetchImpl, calls } = fakeCloudflare([
      { id: 'z-other', name: 'sammy2.party.example', status: 'active', account: { id: accountId } },
      { id: 'z1', name: 'sammy2.party', status: 'active', account: { id: accountId } },
    ]);
    await expect(
      resolveInstallationZone({
        zoneName: 'sammy2.party',
        accountId,
        token: 't',
        withWorkersSubdomain: true,
        fetchImpl,
      })
    ).resolves.toEqual({ zone_id: 'z1', workers_dev_subdomain: 'account-sub' });
    expect(calls[0]).toContain('name=sammy2.party');
    expect(calls.every((url) => !url.includes('method=PUT'))).toBe(true);
  });

  it.each([
    ['no zone', []],
    [
      'a zone in another account',
      [{ id: 'z', name: 'sammy2.party', status: 'active', account: { id: 'x' } }],
    ],
    [
      'a pending zone',
      [{ id: 'z', name: 'sammy2.party', status: 'pending', account: { id: accountId } }],
    ],
    [
      'two zones',
      [
        { id: 'a', name: 'sammy2.party', status: 'active', account: { id: accountId } },
        { id: 'b', name: 'sammy2.party', status: 'active', account: { id: accountId } },
      ],
    ],
  ])('fails closed on %s', async (_label, zones) => {
    const { fetchImpl } = fakeCloudflare(zones);
    await expect(
      resolveInstallationZone({ zoneName: 'sammy2.party', accountId, token: 't', fetchImpl })
    ).rejects.toThrow();
  });

  it('fails when the account has no workers.dev subdomain to share', async () => {
    const { fetchImpl } = fakeCloudflare(
      [{ id: 'z1', name: 'sammy2.party', status: 'active', account: { id: accountId } }],
      { subdomain: '' }
    );
    await expect(
      resolveInstallationZone({
        zoneName: 'sammy2.party',
        accountId,
        token: 't',
        withWorkersSubdomain: true,
        fetchImpl,
      })
    ).rejects.toThrow(/workers.dev/);
  });
});

describe('deploy-reusable.yml secondary installation wiring', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/deploy-reusable.yml', import.meta.url),
    'utf8'
  );
  const step = (name: string) =>
    workflow.match(
      new RegExp(String.raw`      - name: ${name}\n[\s\S]*?(?=\n      - name:|\n      # [A-Z=]|$)`)
    )?.[0] ?? '';

  it('never writes the account-wide workers.dev subdomain for a secondary installation', () => {
    expect(step('Ensure workers.dev Subdomain')).toContain(
      "steps.deploy_resources.outputs.secondary != 'true'"
    );
    expect(step('Resolve Installation Zone')).toContain(
      'node scripts/deploy/resolve-installation-zone.mjs --workers-subdomain'
    );
    expect(step('Set Pulumi Configuration')).toContain(
      'pulumi config set workersDevSubdomain "$WORKERS_DEV_SUBDOMAIN"'
    );
  });

  it('never falls back to the primary zone when the lookup produced nothing', () => {
    const zoneLines = workflow.match(/^ {10}CF_ZONE_ID: .*/gm) ?? [];
    expect(zoneLines.length).toBeGreaterThanOrEqual(3);
    for (const line of zoneLines) {
      expect(line.trim()).toBe(
        "CF_ZONE_ID: ${{ steps.deploy_resources.outputs.secondary == 'true' && (steps.installation_zone.outputs.zone_id || 'unresolved-zone') || secrets.CF_ZONE_ID }}"
      );
    }
  });

  it('does not hand the primary installation identity-bound secrets to a secondary one', () => {
    const configure = step('Configure Worker Secrets');
    for (const name of [
      'GH_CLIENT_ID',
      'GH_APP_PRIVATE_KEY',
      'GH_WEBHOOK_SECRET',
      'GOOGLE_LOGIN_CLIENT_SECRET',
      'BETTER_AUTH_SECRET',
      'CREDENTIAL_ENCRYPTION_KEY',
      'DEPLOY_SIGNING_PRIVATE_KEY',
      'VAPID_PRIVATE_KEY',
    ]) {
      expect(configure).toContain(
        `${name}: \${{ steps.deploy_resources.outputs.secondary != 'true' && secrets.${name} || '' }}`
      );
    }
    expect(configure).toContain(
      "SECRET_ENCRYPTION_KEY: ${{ steps.deploy_resources.outputs.secondary != 'true' && secrets.ENCRYPTION_KEY || '' }}"
    );
    // The primary's trust can never reach a secondary, and the derived trust travels in a file.
    expect(configure).toContain(
      "AGENT_SIGN_IN_TRUST: ${{ steps.deploy_resources.outputs.secondary != 'true' && secrets.AGENT_SIGN_IN_TRUST || '' }}"
    );
    expect(configure).toContain("format('{0}/agent-sign-in-trust.json', runner.temp)");
    expect(workflow).not.toMatch(/installation_trust\.outputs/);
  });

  it('bootstraps secondary installations only and never production', () => {
    const bootstrap = step('Bootstrap Secondary Installation');
    expect(bootstrap).toContain("steps.deploy_resources.outputs.secondary == 'true'");
    expect(bootstrap).toContain("inputs.environment != 'production'");
    expect(bootstrap).toContain(
      'pnpm tsx scripts/deploy/bootstrap-staging-installation.ts bootstrap'
    );
    expect(bootstrap).toContain('echo "::add-mask::$TARGET_ENCRYPTION_KEY"');
  });
});
