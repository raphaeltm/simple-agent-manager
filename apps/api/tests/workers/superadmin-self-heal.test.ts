/**
 * Integration tests for the login-time superadmin self-heal (SAM idea
 * 01KTBCWSTJ83YM280YP7MTE967), exercised against a real Miniflare D1 binding.
 *
 * Two mechanisms share the same guard set and are both validated here:
 *   1. The guarded data migration (0062) — loaded as the genuine SQL artifact via
 *      a Vite `?raw` import and executed against real D1.
 *   2. The `session.create.after` login hook — extracted from a real `createAuth`
 *      instance and invoked against real D1.
 *
 * The system user `system_anonymous_trials` (`SYSTEM_USER_ID`, status='system', seeded by
 * migration 0043) is the orphan that broke first-user promotion; every scenario
 * asserts it is never mutated and never counted as a "real" user.
 */
import { SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/auth';
import migrationSql from '../../src/db/migrations/0062_login_time_superadmin_self_heal.sql?raw';
import { FIRST_SUPERADMIN_SETTING } from '../../src/services/first-superadmin';

/**
 * Miniflare's D1 `exec()` splits its input on newlines and runs each line as a
 * separate statement. The migration is a single multi-line UPDATE preceded by a
 * 28-line `--` comment block. Naively collapsing newlines to spaces would fold
 * those `--` comments onto the same line as the UPDATE, turning the entire
 * statement into one trailing line-comment that never executes. Strip the
 * comment lines first, THEN join, so a single comment-free statement reaches D1.
 */
const MIGRATION_UPDATE_SQL = migrationSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ');

interface UserRow {
  id: string;
  role: string;
  status: string;
}

/**
 * Reset the users table to a known baseline: only the system sentinel exists.
 * The Miniflare harness auto-applies all migrations (including 0043 which seeds
 * the sentinel and 0062 which is a no-op against the sentinel-only baseline), so
 * we clear any real users left over from prior tests and re-assert the sentinel.
 */
async function resetUsers(): Promise<void> {
  await env.DATABASE.prepare('DELETE FROM platform_settings WHERE key = ?')
    .bind(FIRST_SUPERADMIN_SETTING)
    .run();
  await env.DATABASE.prepare(`DELETE FROM users WHERE status != 'system'`).run();
  await env.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, role, status)
     VALUES (?, 'anonymous-trials@simple-agent-manager.internal', 0, 'user', 'system')
     ON CONFLICT(id) DO UPDATE SET role = 'user', status = 'system'`,
  )
    .bind(SYSTEM_USER_ID)
    .run();
}

async function insertUser(
  id: string,
  opts?: { role?: string; status?: string },
): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, role, status)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET role = excluded.role, status = excluded.status`,
  )
    .bind(id, `${id}@example.com`, opts?.role ?? 'user', opts?.status ?? 'active')
    .run();
}

async function getUser(id: string): Promise<UserRow | null> {
  return env.DATABASE.prepare(`SELECT id, role, status FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
}

/**
 * Build the minimal env `createAuth` needs to construct and to run the
 * `session.create.after` hook closure (which only touches env.DATABASE and the
 * resolved sentinel id).
 */
function authEnv(overrides?: Record<string, unknown>) {
  return {
    DATABASE: env.DATABASE,
    BASE_DOMAIN: 'test.example.com',
    ENCRYPTION_KEY: 'test-encryption-key',
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    REQUIRE_APPROVAL: 'true',
    ...overrides,
  };
}

type SessionAfterHook = (session: { userId?: string | null }) => Promise<void>;

async function getSessionAfterHook(overrides?: Record<string, unknown>): Promise<SessionAfterHook> {
  const auth = await createAuth(authEnv(overrides) as never);
  const hook = (
    auth.options as {
      databaseHooks?: { session?: { create?: { after?: SessionAfterHook } } };
    }
  ).databaseHooks?.session?.create?.after;
  if (!hook) {
    throw new Error('session.create.after hook was not registered');
  }
  return hook;
}

describe('migration 0062 — guarded superadmin backfill (real D1)', () => {
  beforeEach(resetUsers);

  it('promotes the sole real user when only the sentinel co-exists', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });

    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
    // Sentinel is never touched.
    expect(await getUser(SYSTEM_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('does nothing when two real users exist (not single-operator)', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    await insertUser('real-2', { role: 'user', status: 'active' });

    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    expect(await getUser('real-1')).toMatchObject({ role: 'user' });
    expect(await getUser('real-2')).toMatchObject({ role: 'user' });
  });

  it('does nothing when a non-system superadmin already exists', async () => {
    await insertUser('admin-1', { role: 'superadmin', status: 'active' });

    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    // The would-be victim count is 1 real user, but a superadmin exists -> no-op.
    expect(await getUser('admin-1')).toMatchObject({ role: 'superadmin' });
  });

  it('never auto-elevates a suspended sole user', async () => {
    await insertUser('real-1', { role: 'user', status: 'suspended' });

    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    expect(await getUser('real-1')).toMatchObject({ role: 'user', status: 'suspended' });
  });

  it('promotes a sole pending user (edge case 10)', async () => {
    await insertUser('real-1', { role: 'user', status: 'pending' });

    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('is a no-op on a sentinel-only deployment (no real users to promote)', async () => {
    // Only the system sentinel exists (the resetUsers baseline). The migration must
    // not promote it — there is no real human to heal.
    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    expect(await getUser(SYSTEM_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
    const superadmins = await env.DATABASE.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'`,
    ).first<{ n: number }>();
    expect(superadmins?.n).toBe(0);
  });
});

describe('session.create.after — login-time self-heal (real D1)', () => {
  beforeEach(resetUsers);

  it('promotes the sole real user on login', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(await getUser(SYSTEM_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('is idempotent — a second login is a no-op', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-1' });
    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('does not promote when another real user already exists', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    await insertUser('real-2', { role: 'user', status: 'pending' });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-2' });

    expect(await getUser('real-2')).toMatchObject({ role: 'user', status: 'pending' });
  });

  it('does not promote when a non-system superadmin exists', async () => {
    await insertUser('admin-1', { role: 'superadmin', status: 'active' });
    await insertUser('real-1', { role: 'user', status: 'active' });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'user' });
  });

  it('does not reopen administration after the one-time election has completed', async () => {
    await insertUser('later-user', { role: 'user', status: 'pending' });
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES (?, json_object('version', 1, 'ownerId', 'deleted-owner'), NULL)`,
    )
      .bind(FIRST_SUPERADMIN_SETTING)
      .run();
    const hook = await getSessionAfterHook();

    await hook({ userId: 'later-user' });

    expect(await getUser('later-user')).toMatchObject({ role: 'user', status: 'pending' });
  });

  it.each([
    ['never promotes a suspended user, even as sole operator', 'suspended', { role: 'user', status: 'suspended' }],
    ['promotes a sole pending user on login (edge case 10)', 'pending', { role: 'superadmin', status: 'active' }],
  ])('%s', async (_name, status, expected) => {
    await insertUser('real-1', { role: 'user', status });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject(expected);
  });

  it('promotes the sole user even when REQUIRE_APPROVAL is unset (approval on by default)', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    // Omit REQUIRE_APPROVAL entirely — the self-heal is ungated and must still fire.
    const hook = await getSessionAfterHook({ REQUIRE_APPROVAL: undefined });

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('lets the first user of a fresh install with REQUIRE_APPROVAL unset in as an active superadmin', async () => {
    // Approval is on by default, so the real create hook makes the first account pending...
    const auth = await createAuth(authEnv({ REQUIRE_APPROVAL: undefined }) as never);
    const hooks = (
      auth.options as {
        databaseHooks?: {
          user?: { create?: { before?: (u: Record<string, unknown>) => Promise<unknown> } };
          session?: { create?: { before?: (s: { userId: string }) => Promise<unknown> } };
        };
      }
    ).databaseHooks;
    const created = (await hooks?.user?.create?.before?.({ id: 'first-user' })) as {
      data: { role?: string; status?: string };
    };
    expect(created.data).toMatchObject({ role: 'user', status: 'pending' });
    await insertUser('first-user', { role: created.data.role, status: created.data.status });

    // ...and its first session elects it, so the owner is never locked out of Admin -> Users.
    await hooks?.session?.create?.before?.({ userId: 'first-user' });

    expect(await getUser('first-user')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('never mutates the sentinel even if its id is passed as the login user', async () => {
    const hook = await getSessionAfterHook();

    await hook({ userId: SYSTEM_USER_ID });

    expect(await getUser(SYSTEM_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('never counts any status=system row as a real user, whatever its id', async () => {
    // Re-seed: a differently-named system row plus the real user. The default system user is
    // removed so only the status guard can keep the other row out of the "single operator"
    // count. (The retired TRIAL_ANONYMOUS_USER_ID override is ignored.)
    await env.DATABASE.prepare(`DELETE FROM users`).run();
    await env.DATABASE.prepare(
      `INSERT INTO users (id, email, email_verified, role, status)
       VALUES ('custom_sentinel', 'c@x.internal', 0, 'user', 'system')`,
    ).run();
    await insertUser('real-1', { role: 'user', status: 'active' });

    const hook = await getSessionAfterHook({ TRIAL_ANONYMOUS_USER_ID: 'custom_sentinel' });
    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });
});

/**
 * The ordinary first-superadmin election runs in `session.create.before`. These tests create a
 * session through BetterAuth's own `internalAdapter.createSession` (the path every sign-in takes,
 * `services/session-factory.ts`), so the real hook chain runs against real D1.
 */
describe('session.create.before — first-superadmin election via BetterAuth (real D1)', () => {
  beforeEach(resetUsers);

  async function createSession(userId: string, overrides?: Record<string, unknown>) {
    const auth = await createAuth(authEnv(overrides) as never);
    const ctx = await auth.$context;
    return ctx.internalAdapter.createSession(userId, false);
  }

  async function electionMarker(): Promise<string | null> {
    const row = await env.DATABASE.prepare('SELECT value FROM platform_settings WHERE key = ?')
      .bind(FIRST_SUPERADMIN_SETTING)
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as { ownerId: string }).ownerId : null;
  }

  it('elects the sole real user when their first session is created', async () => {
    await insertUser('first-user', { role: 'user', status: 'pending' });

    const session = await createSession('first-user');

    expect(session?.userId).toBe('first-user');
    expect(await getUser('first-user')).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(await electionMarker()).toBe('first-user');
  });

  it('does not elect a new sign-up while another real account exists', async () => {
    await insertUser('existing-user', { role: 'user', status: 'suspended' });
    await insertUser('stranger', { role: 'user', status: 'pending' });

    const session = await createSession('stranger');

    expect(session?.userId).toBe('stranger');
    expect(await getUser('stranger')).toMatchObject({ role: 'user', status: 'pending' });
    expect(await electionMarker()).toBeNull();
  });

  it('still creates the session, unpromoted, when D1 fails the election writes', async () => {
    await insertUser('first-user', { role: 'user', status: 'pending' });
    // Fail every D1 batch (the election) and every UPDATE of users (the election and the
    // after-hook self-heal), while BetterAuth's own session INSERT goes through.
    const outage = () => Promise.reject(new Error('D1_ERROR: simulated outage'));
    const failingWrites = new Proxy(env.DATABASE, {
      get(target, property) {
        if (property === 'batch') return outage;
        if (property === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!/^\s*UPDATE users\b/i.test(sql)) return statement;
            return new Proxy(statement, {
              get(inner, key) {
                if (key === 'bind') return () => ({ run: outage, first: outage, all: outage });
                if (key === 'run' || key === 'first' || key === 'all') return outage;
                const value = Reflect.get(inner, key, inner) as unknown;
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const session = await createSession('first-user', { DATABASE: failingWrites });

    expect(session?.userId).toBe('first-user');
    const stored = await env.DATABASE.prepare('SELECT user_id FROM sessions WHERE id = ?')
      .bind(session?.id)
      .first<{ user_id: string }>();
    expect(stored?.user_id).toBe('first-user');
    expect(await getUser('first-user')).toMatchObject({ role: 'user', status: 'pending' });
    expect(await electionMarker()).toBeNull();

    // Liveness: the same user is elected on the next sign-in once D1 recovers.
    await createSession('first-user');
    expect(await getUser('first-user')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('recovers a deleted sole superadmin through BOOTSTRAP_OWNER_EMAIL (documented path)', async () => {
    // The election is closed for good: its winner was deleted and only ordinary accounts remain.
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES (?, json_object('version', 1, 'ownerId', 'deleted-owner'), NULL)`,
    )
      .bind(FIRST_SUPERADMIN_SETTING)
      .run();
    await insertUser('member', { role: 'user', status: 'active' });
    await insertUser('owner', { role: 'user', status: 'active' });
    const recovery = { BOOTSTRAP_OWNER_EMAIL: 'owner@example.com' };

    try {
      // Without the binding, the closed election promotes nobody.
      await createSession('owner');
      expect(await getUser('owner')).toMatchObject({ role: 'user' });

      await createSession('owner', recovery);

      expect(await getUser('owner')).toMatchObject({ role: 'superadmin', status: 'active' });
      expect(await getUser('member')).toMatchObject({ role: 'user', status: 'active' });
    } finally {
      await env.DATABASE.prepare(
        `DELETE FROM platform_settings WHERE key = 'setup.bootstrapOwnerEstablished'`,
      ).run();
    }
  });

  it('skips the election on installer instances bound to BOOTSTRAP_OWNER_EMAIL', async () => {
    await env.DATABASE.prepare(
      `INSERT INTO platform_settings (key, value, updated_by)
       VALUES ('setup.bootstrapOwnerEstablished', json_object('version', 1, 'ownerId', 'owner'), NULL)
       ON CONFLICT(key) DO NOTHING`,
    ).run();
    await insertUser('member', { role: 'user', status: 'active' });

    try {
      await createSession('member', { BOOTSTRAP_OWNER_EMAIL: 'owner@example.com' });

      expect(await getUser('member')).toMatchObject({ role: 'user', status: 'active' });
      expect(await electionMarker()).toBeNull();
    } finally {
      await env.DATABASE.prepare(
        `DELETE FROM platform_settings WHERE key = 'setup.bootstrapOwnerEstablished'`,
      ).run();
    }
  });
});
