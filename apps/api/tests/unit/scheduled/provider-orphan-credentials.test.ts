import type { Provider, VMInstance } from '@simple-agent-manager/providers';
import { createProvider } from '@simple-agent-manager/providers';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { platformErrors } from '../../../src/db/observability-schema';
import { credentials, nodes, projects, users } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  listInventoryCredentials,
  markInventoryCredentialAttempted,
  resolveInventoryProvider,
} from '../../../src/scheduled/provider-orphan-credentials';
import { reconcileProviderOrphans } from '../../../src/scheduled/provider-orphan-reconciliation-core';
import { getPlatformCloudCredential } from '../../../src/services/platform-credentials';
import { createProviderForUser } from '../../../src/services/provider-credentials';
import { createMemoryKv, createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/provider-credentials', async (original) => ({
  ...(await original<typeof import('../../../src/services/provider-credentials')>()),
  createProviderForUser: vi.fn(),
}));
vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformCloudCredential: vi.fn(),
}));
vi.mock('@simple-agent-manager/providers', async (original) => ({
  ...(await original<typeof import('@simple-agent-manager/providers')>()),
  createProvider: vi.fn(),
}));

const now = new Date('2026-10-29T12:00:00Z');
const scope = { environmentLabel: 'production', installationId: 'test-installation' };
const orphan = '01kx84mcg1yn1tqvwr60b3g70a';
const live = '01kzb1ehkkwha6pqemn3p9xfmb';
const cursorKey = 'cleanup:provider-orphan-reconciliation:credential-cursor';
function server(id: string, node = orphan): VMInstance {
  return {
    id,
    name: `node-${node}`,
    ip: '192.0.2.1',
    status: 'running',
    serverType: 'cx23',
    createdAt: '2026-10-28T00:00:00Z',
    labels: {
      managed: 'simple-agent-manager',
      node,
      env: scope.environmentLabel,
      installation: scope.installationId,
    },
  } as VMInstance;
}
function provider(servers: VMInstance[]) {
  return {
    listVMs: vi.fn().mockResolvedValue(servers),
    getVM: vi.fn(async (id: string) => servers.find((s) => s.id === id) ?? null),
    deleteVM: vi.fn().mockResolvedValue(undefined),
  };
}

describe('credential inventory and real SQL orphan claims', () => {
  let sqlite: Database.Database;
  let env: Env;
  beforeEach(() => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [credentials, nodes, users, projects, platformErrors]);
    const database = createSqliteD1(sqlite);
    env = {
      DATABASE: database,
      OBSERVABILITY_DATABASE: database,
      KV: createMemoryKv(),
      ENCRYPTION_KEY: 'test-key',
      NODE_CLEANUP_SWEEP_LIMIT: '2',
      PROVIDER_ORPHAN_MIN_AGE_MS: '1000',
      PROVIDER_ORPHAN_DESTROY_LIMIT: '10',
    } as Env;
    sqlite.exec(
      "INSERT INTO users (id, name, email) VALUES ('user-1', 'Test User', 'test@example.test'); INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'user-1', 'Test Project')"
    );
    vi.mocked(getPlatformCloudCredential).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sqlite.close();
  });
  function credential(
    id: string,
    project: string | null = null,
    active = 1,
    type = 'cloud-provider'
  ) {
    sqlite
      .prepare(
        'INSERT INTO credentials (id, user_id, project_id, provider, credential_type, is_active, encrypted_token, iv, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        id,
        'user-1',
        project,
        'hetzner',
        type,
        active,
        `ciphertext-${id}`,
        'test-iv',
        '2026-10-28T00:00:00Z'
      );
  }
  function account(id: string, p: ReturnType<typeof provider>) {
    vi.mocked(createProviderForUser).mockImplementation(async (...args) => {
      if (args[6]?.credentialReference !== `credentials:${id}`)
        throw new Error('unexpected credential');
      return { provider: p as unknown as Provider } as Awaited<
        ReturnType<typeof createProviderForUser>
      >;
    });
  }
  it('rotates bounded pages of active user and project cloud credentials and resets at the end', async () => {
    credential('a');
    credential('b', 'project-1');
    credential('c');
    credential('d', null, 0);
    credential('e', null, 1, 'git');
    const first = await listInventoryCredentials(env);
    expect(first.map((c) => [c.id, c.projectId])).toEqual([
      ['a', null],
      ['b', 'project-1'],
    ]);
    await markInventoryCredentialAttempted(env, first[0]!);
    expect((await listInventoryCredentials(env)).map((c) => c.id)).toEqual(['b', 'c']);
    await markInventoryCredentialAttempted(env, (await listInventoryCredentials(env))[1]!);
    expect(await listInventoryCredentials(env)).toEqual([]);
    expect((await listInventoryCredentials(env)).map((c) => c.id)).toEqual(['a', 'b']);
  });
  it.each([null, 'project-1'])(
    'binds exact credential generation and scope for project %s',
    async (project) => {
      credential('a', project);
      const p = provider([]);
      account('a', p);
      await resolveInventoryProvider(env, (await listInventoryCredentials(env))[0]!);
      expect(vi.mocked(createProviderForUser).mock.calls[0]?.slice(1, 7)).toEqual([
        'user-1',
        'test-key',
        env,
        'hetzner',
        project,
        expect.objectContaining({
          credentialSource: project ? 'project' : 'user',
          credentialReference: 'credentials:a',
          credentialVersion: Date.parse('2026-10-28T00:00:00Z'),
          credentialFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
      ]);
    }
  );
  it('scans user credentials without a platform credential and preserves live SQL claims', async () => {
    credential('a');
    sqlite
      .prepare('INSERT INTO nodes (id, user_id, status, provider_instance_id) VALUES (?, ?, ?, ?)')
      .run(live.toUpperCase(), 'user-1', 'running', 'claimed');
    const p = provider([server('unclaimed'), server('claimed', live)]);
    account('a', p);
    const result = await reconcileProviderOrphans(env, now, scope);
    expect(result).toMatchObject({
      skipped: false,
      scanned: 2,
      destroyed: 1,
      skippedClaimed: 1,
      errors: 0,
    });
    expect(p.deleteVM.mock.calls.map((c) => c[0])).toEqual(['unclaimed']);
    expect(p.getVM.mock.calls.map((c) => c[0])).toEqual(['unclaimed']);
    expect(sqlite.prepare('SELECT node_id FROM platform_errors').all()).toEqual([
      { node_id: orphan },
    ]);
  });
  it('shares the destroy budget across platform and user accounts', async () => {
    credential('a');
    credential('b');
    env.PROVIDER_ORPHAN_DESTROY_LIMIT = '2';
    const platform = provider([server('platform')]);
    const user = provider([server('user-1'), server('user-2')]);
    vi.mocked(getPlatformCloudCredential).mockResolvedValue({
      provider: 'hetzner',
      decryptedToken: 'test-token',
    } as Awaited<ReturnType<typeof getPlatformCloudCredential>>);
    vi.mocked(createProvider).mockReturnValue(platform as unknown as Provider);
    account('a', user);
    const result = await reconcileProviderOrphans(env, now, scope);
    expect(result.destroyed).toBe(2);
    expect(platform.deleteVM.mock.calls.map((c) => c[0])).toEqual(['platform']);
    expect(user.deleteVM.mock.calls.map((c) => c[0])).toEqual(['user-1']);
    expect(createProviderForUser).toHaveBeenCalledTimes(1);
    expect(await env.KV.get(cursorKey)).toBe('a');
  });
  it('advances only attempted credentials when account resolution fails', async () => {
    credential('a');
    credential('b');
    credential('c');
    vi.mocked(createProviderForUser).mockRejectedValue(new Error('credential unavailable'));
    const result = await reconcileProviderOrphans(env, now, scope);
    expect(result.errors).toBe(2);
    expect(createProviderForUser).toHaveBeenCalledTimes(2);
    expect(await env.KV.get(cursorKey)).toBe('b');
    expect((await listInventoryCredentials(env)).map((c) => c.id)).toEqual(['c']);
  });
  it('preserves resources when provider inventory fails', async () => {
    credential('a');
    const p = provider([server('preserved')]);
    p.listVMs.mockRejectedValue(new Error('partial page failed'));
    account('a', p);
    expect(await reconcileProviderOrphans(env, now, scope)).toMatchObject({
      destroyed: 0,
      errors: 1,
    });
    expect(p.deleteVM).not.toHaveBeenCalled();
    expect(await env.KV.get(cursorKey)).toBe('a');
  });
  it.each(['partial', 'failed'])(
    'preserves resources when SQL claim inventory is %s',
    async (failure) => {
      credential('a');
      const p = provider([server('preserved'), server('also-preserved', live)]);
      account('a', p);
      const prepare = env.DATABASE.prepare.bind(env.DATABASE);
      vi.spyOn(env.DATABASE, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql);
        if (!sql.includes('WITH requested')) return statement;
        const bind = statement.bind.bind(statement);
        return {
          ...statement,
          bind: (...values: unknown[]) => {
            const bound = bind(...values);
            return {
              ...bound,
              all: async () => {
                const rows = await bound.all();
                return failure === 'partial'
                  ? { ...rows, results: rows.results.slice(0, 1) }
                  : { ...rows, success: false };
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      });
      expect(await reconcileProviderOrphans(env, now, scope)).toMatchObject({
        destroyed: 0,
        errors: 1,
        skipReason: 'claim-lookup-failed',
      });
      expect(p.deleteVM).not.toHaveBeenCalled();
    }
  );
  it('leaves unattempted credentials for the next sweep when the time budget expires', async () => {
    credential('a');
    credential('b');
    env.NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS = '10';
    let clock = now.getTime();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const p = provider([]);
    vi.mocked(createProviderForUser).mockImplementation(async () => {
      clock += 20;
      return { provider: p as unknown as Provider } as Awaited<
        ReturnType<typeof createProviderForUser>
      >;
    });
    await reconcileProviderOrphans(env, now, scope);
    expect(createProviderForUser).toHaveBeenCalledTimes(1);
    expect(await env.KV.get(cursorKey)).toBe('a');
    expect((await listInventoryCredentials(env)).map((c) => c.id)).toEqual(['b']);
  });
  it('fails closed when the credential SQL query fails', async () => {
    credential('a');
    sqlite.exec('DROP TABLE credentials');
    expect(await reconcileProviderOrphans(env, now, scope)).toMatchObject({
      destroyed: 0,
      errors: 1,
    });
    expect(createProviderForUser).not.toHaveBeenCalled();
  });
});
