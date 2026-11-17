import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  bootstrapInstallation,
  bootstrapUsers,
  type D1Like,
  findDatabaseIdByName,
  installationDatabaseName,
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
      assets_bucket: 'sam2-staging2-assets',
      pulumi_state_bucket: 'sam-pulumi-state',
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

describe('bootstrapInstallation on the real migration chain', () => {
  let target: ReturnType<typeof migratedDatabase>;
  const logs: string[] = [];

  function run(overrides: Partial<Parameters<typeof bootstrapInstallation>[0]> = {}) {
    return bootstrapInstallation({
      installation: 'staging2',
      environment: 'staging',
      baseDomain: 'sammy2.party',
      target: target.d1,
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
    logs.length = 0;
  });

  it('seeds the two test users, opts them into the SAM AI proxy, and closes setup', async () => {
    const report = await run();

    expect(report).toEqual({
      users: ['staging2-agent-admin', 'staging2-agent-user'],
      proxyAgents: ['claude-code'],
    });
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
    expect(
      target.db
        .prepare(`SELECT user_id, agent_type, provider_mode FROM agent_settings ORDER BY user_id`)
        .all()
    ).toEqual([
      { user_id: 'staging2-agent-admin', agent_type: 'claude-code', provider_mode: 'sam' },
      { user_id: 'staging2-agent-user', agent_type: 'claude-code', provider_mode: 'sam' },
    ]);
  });

  it('writes no credential, token or secret-bearing row', async () => {
    await run();
    for (const table of ['platform_credentials', 'credentials', 'smoke_test_tokens']) {
      expect(count(target.db, table)).toBe(0);
    }
  });

  it('is idempotent and leaves an admin change alone', async () => {
    await run();
    target.db.prepare(`UPDATE users SET role = 'user' WHERE id = 'staging2-agent-admin'`).run();
    target.db
      .prepare(
        `UPDATE agent_settings SET provider_mode = 'user-api-key' WHERE user_id = 'staging2-agent-user'`
      )
      .run();
    await run();
    expect(
      target.db.prepare(`SELECT role FROM users WHERE id = 'staging2-agent-admin'`).get()
    ).toEqual({ role: 'user' });
    expect(
      target.db
        .prepare(`SELECT provider_mode FROM agent_settings WHERE user_id = 'staging2-agent-user'`)
        .get()
    ).toEqual({ provider_mode: 'user-api-key' });
    expect(count(target.db, 'agent_settings')).toBe(2);
  });

  it.each([
    ['production environment', { environment: 'production' }],
    ['production-like installation', { installation: 'prod' }],
    ['the primary staging itself', { installation: 'staging' }],
    ['an unregistered installation', { installation: 'staging9' }],
    ['a domain other than the registered one', { baseDomain: 'simple-agent-manager.org' }],
    ['another environment', { environment: 'development' }],
  ])('refuses %s before writing anything', async (_label, overrides) => {
    await expect(run(overrides)).rejects.toThrow();
    expect(count(target.db, 'users')).toBe(1); // the migration-seeded system user only
    expect(count(target.db, 'agent_settings')).toBe(0);
  });

  it('names the users an agent sign-in trust can allow', () => {
    expect(bootstrapUsers('staging2', 'sammy2.party').map((u) => u.id)).toEqual([
      'staging2-agent-admin',
      'staging2-agent-user',
    ]);
  });
});

describe('findDatabaseIdByName', () => {
  function fakeFetch(status: number, body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }
  const lookup = (fetchImpl: typeof fetch) =>
    findDatabaseIdByName({ accountId: 'a', apiToken: 't', name: 'sam2-staging2', fetchImpl });

  it('names the registered database and returns the exact match only', async () => {
    expect(installationDatabaseName('staging2')).toBe('sam2-staging2');
    await expect(
      lookup(
        fakeFetch(200, {
          success: true,
          result: [
            { uuid: 'other', name: 'sam2-staging2-old' },
            { uuid: 'db-1', name: 'sam2-staging2' },
          ],
        })
      )
    ).resolves.toBe('db-1');
  });

  it.each([
    ['no database', { success: true, result: [] }, 200],
    [
      'two databases',
      {
        success: true,
        result: [
          { uuid: '1', name: 'sam2-staging2' },
          { uuid: '2', name: 'sam2-staging2' },
        ],
      },
      200,
    ],
    ['an API error', { success: false, result: [] }, 403],
  ])('fails closed on %s', async (_label, body, status) => {
    await expect(lookup(fakeFetch(status, body))).rejects.toThrow();
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

  it.each(['production', 'prod', 'Production', 'preprod', 'live', 'prd', 'staging9', ''])(
    'refuses %j (allowlist, not deny-list)',
    (name) => {
      expect(() => workflowTargetFor(name, 'example.org')).toThrow(/staging workflows target only/);
    }
  );

  it('refuses a primary domain that could inject an output line', () => {
    expect(() => workflowTargetFor('staging', 'sammy.party\nbase_domain=evil')).toThrow(
      /valid domain/
    );
  });

  it.each(['production', 'prod'])('refuses %s', (name) => {
    expect(() => workflowTargetFor(name, 'example.org')).toThrow();
  });

  it('needs a domain for a primary', () => {
    expect(() => workflowTargetFor('staging', undefined)).toThrow(/valid domain/);
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
    // The primary's trust never reaches a secondary, and an unset secondary trust leaves the
    // Worker secret alone instead of deleting it.
    expect(configure).toContain(
      "AGENT_SIGN_IN_TRUST: ${{ steps.deploy_resources.outputs.secondary != 'true' && secrets.AGENT_SIGN_IN_TRUST || '' }}"
    );
    expect(configure).toContain(
      "AGENT_SIGN_IN_TRUST_KEEP_WHEN_UNSET: ${{ steps.deploy_resources.outputs.secondary == 'true' && 'true' || '' }}"
    );
    // A secondary's own trust is passed straight in and written in the same bulk deployment.
    expect(configure).toContain(
      "SECONDARY_AGENT_SIGN_IN_TRUST: ${{ steps.deploy_resources.outputs.secondary == 'true' && steps.deploy_resources.outputs.installation == 'staging2' && secrets.AGENT_SIGN_IN_TRUST_STAGING2 || '' }}"
    );
    expect(workflow).not.toContain('wrangler secret put');
    expect(workflow).not.toMatch(/derive-trust|agent-sign-in-trust\.json/);
  });

  it('bootstraps secondary installations only and never production', () => {
    const bootstrap = step('Bootstrap Secondary Installation');
    expect(bootstrap).toContain("steps.deploy_resources.outputs.secondary == 'true'");
    expect(bootstrap).toContain("inputs.environment != 'production'");
    expect(bootstrap).toContain('run: pnpm tsx scripts/deploy/bootstrap-staging-installation.ts');
  });

  it('hands the bootstrap no key, token or Pulumi state (policy 795e72a6)', () => {
    const bootstrap = step('Bootstrap Secondary Installation');
    expect(bootstrap).not.toBe('');
    const secrets = [...bootstrap.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    expect(secrets).toEqual(['CF_ACCOUNT_ID', 'CF_API_TOKEN']);
    expect(bootstrap).not.toMatch(/pulumi|ENCRYPTION_KEY|SMOKE_TEST_TOKEN|AGENT_SIGN_IN_TRUST/);
  });
});
