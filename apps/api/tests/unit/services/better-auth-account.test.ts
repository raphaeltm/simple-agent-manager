import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { getBetterAuthAccessTokenForProvider } from '../../../src/services/better-auth-access-token';
import { getBetterAuthAccountIdForProvider } from '../../../src/services/better-auth-account';
import { generateEncryptionKey } from '../../../src/services/encryption';
import { gitlabAccountScope } from '../../../src/services/gitlab-sign-in-identity';
import {
  __resetPlatformConfigCacheForTest,
  completeSetupWithConfig,
} from '../../../src/services/platform-config';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

type AccountRow = { id: string; userId: string; providerId: string };

function makeEnv(rows: AccountRow[]) {
  const first = vi.fn(async (userId: string, providerId: string) => {
    const row = rows.find((candidate) => {
      return candidate.userId === userId && candidate.providerId === providerId;
    });
    return row ? { id: row.id } : null;
  });
  const bind = vi.fn((userId: string, providerId: string) => ({
    first: () => first(userId, providerId),
  }));
  const prepare = vi.fn(() => ({ bind }));
  return { env: { DATABASE: { prepare } } as unknown as Env, prepare, bind };
}

describe('getBetterAuthAccountIdForProvider', () => {
  const rows: AccountRow[] = [
    { id: 'user-1-github', userId: 'user-1', providerId: 'github' },
    { id: 'user-1-gitlab', userId: 'user-1', providerId: 'gitlab' },
    { id: 'user-2-github', userId: 'user-2', providerId: 'github' },
  ];

  it.each([
    ['github', 'user-1-github'],
    ['gitlab', 'user-1-gitlab'],
  ] as const)(
    'binds the user before %s and selects that provider account',
    async (provider, id) => {
      const { env, prepare, bind } = makeEnv(rows);

      await expect(getBetterAuthAccountIdForProvider(env, 'user-1', provider)).resolves.toBe(id);
      expect(bind).toHaveBeenCalledWith('user-1', provider);
      expect(prepare).toHaveBeenCalledWith(
        expect.stringMatching(/user_id\s*=\s*\?[\s\S]*provider_id\s*=\s*\?/)
      );
    }
  );

  it('does not select another user account and returns null without an exact match', async () => {
    const { env, bind } = makeEnv(rows);

    await expect(getBetterAuthAccountIdForProvider(env, 'user-3', 'github')).resolves.toBeNull();
    expect(bind).toHaveBeenCalledWith('user-3', 'github');
  });
});

/**
 * A user can hold GitLab rows from more than one host: gitlab.com rows carry raw ids, rows a
 * self-managed host saved at runtime issued carry `<host>/users/<id>`. A token lookup must pick
 * only the configured host's row, or one host's token is refreshed against and sent to another.
 * Real SQL, so the scope predicate is actually evaluated.
 */
describe('getBetterAuthAccountIdForProvider GitLab host scope (real SQL)', () => {
  const SELF_MANAGED = 'https://gitlab.selfhosted.example';
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const now = Date.parse('2026-11-01T00:00:00Z');
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('user-1', 'u1@example.com', 1, 'U1', 'user', 'active', ?, ?)`
      )
      .run(now, now);
    const insert = sqlite.prepare(
      `INSERT INTO accounts (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES (?, ?, 'gitlab', 'user-1', ?, ?)`
    );
    // The gitlab.com row is the most recently updated, so an unscoped lookup returns it.
    insert.run('row-self-managed', `${SELF_MANAGED}/users/7`, now, now);
    insert.run('row-gitlab-com', '7', now, now + 1000);
    insert.run('row-other-host', 'https://gitlab.other.example/users/7', now, now + 2000);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
  });

  afterEach(() => sqlite.close());

  it('selects only the configured untrusted host’s row', async () => {
    await expect(
      getBetterAuthAccountIdForProvider(
        env,
        'user-1',
        'gitlab',
        gitlabAccountScope({ host: SELF_MANAGED, identityTrusted: false })
      )
    ).resolves.toBe('row-self-managed');
  });

  it('selects only a raw-id row for gitlab.com or a pinned host', async () => {
    await expect(
      getBetterAuthAccountIdForProvider(
        env,
        'user-1',
        'gitlab',
        gitlabAccountScope({ host: 'https://gitlab.com', identityTrusted: true })
      )
    ).resolves.toBe('row-gitlab-com');
  });

  it('returns nothing when the configured host issued none of the user’s rows', async () => {
    sqlite.prepare(`DELETE FROM accounts WHERE id = 'row-self-managed'`).run();

    await expect(
      getBetterAuthAccountIdForProvider(
        env,
        'user-1',
        'gitlab',
        gitlabAccountScope({ host: SELF_MANAGED, identityTrusted: false })
      )
    ).resolves.toBeNull();
  });
});

describe('getBetterAuthAccessTokenForProvider GitLab host scope', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    __resetPlatformConfigCacheForTest();
  });

  afterEach(() => sqlite.close());

  it('never hands a gitlab.com token to a self-managed host configured at runtime', async () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    sqlite
      .prepare(
        `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
         VALUES ('user-1', 'u1@example.com', 1, 'U1', 'user', 'active', ?, ?)`
      )
      .run(now, now);
    sqlite
      .prepare(
        `INSERT INTO accounts (id, account_id, provider_id, user_id, access_token, created_at, updated_at)
         VALUES ('row-gitlab-com', '7', 'gitlab', 'user-1', 'encrypted', ?, ?)`
      )
      .run(now, now);
    const env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
      ENCRYPTION_KEY: generateEncryptionKey(),
    } as Env;
    await completeSetupWithConfig(env, {
      gitlab: {
        host: 'https://gitlab.selfhosted.example',
        clientId: 'gitlab-client-id',
        clientSecret: 'gitlab-client-secret',
      },
    });
    __resetPlatformConfigCacheForTest();

    await expect(
      getBetterAuthAccessTokenForProvider(env, undefined, 'user-1', 'gitlab')
    ).resolves.toBeNull();
  });
});
