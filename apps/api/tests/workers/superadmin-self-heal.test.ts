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
 * The sentinel user `system_anonymous_trials` (status='system', seeded by
 * migration 0043) is the orphan that broke first-user promotion; every scenario
 * asserts it is never mutated and never counted as a "real" user.
 */
import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/auth';
import migrationSql from '../../src/db/migrations/0062_login_time_superadmin_self_heal.sql?raw';

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
  await env.DATABASE.prepare(`DELETE FROM users WHERE status != 'system'`).run();
  await env.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, role, status)
     VALUES (?, 'anonymous-trials@simple-agent-manager.internal', 0, 'user', 'system')
     ON CONFLICT(id) DO UPDATE SET role = 'user', status = 'system'`,
  )
    .bind(TRIAL_ANONYMOUS_USER_ID)
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

function getSessionAfterHook(overrides?: Record<string, unknown>): SessionAfterHook {
  const auth = createAuth(authEnv(overrides) as never);
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

    await env.DATABASE.exec(migrationSql.replaceAll('\n', ' '));

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
    // Sentinel is never touched.
    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('does nothing when two real users exist (not single-operator)', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    await insertUser('real-2', { role: 'user', status: 'active' });

    await env.DATABASE.exec(migrationSql.replaceAll('\n', ' '));

    expect(await getUser('real-1')).toMatchObject({ role: 'user' });
    expect(await getUser('real-2')).toMatchObject({ role: 'user' });
  });

  it('does nothing when a non-system superadmin already exists', async () => {
    await insertUser('admin-1', { role: 'superadmin', status: 'active' });

    await env.DATABASE.exec(migrationSql.replaceAll('\n', ' '));

    // The would-be victim count is 1 real user, but a superadmin exists -> no-op.
    expect(await getUser('admin-1')).toMatchObject({ role: 'superadmin' });
  });

  it('never auto-elevates a suspended sole user', async () => {
    await insertUser('real-1', { role: 'user', status: 'suspended' });

    await env.DATABASE.exec(migrationSql.replaceAll('\n', ' '));

    expect(await getUser('real-1')).toMatchObject({ role: 'user', status: 'suspended' });
  });
});

describe('session.create.after — login-time self-heal (real D1)', () => {
  beforeEach(resetUsers);

  it('promotes the sole real user on login', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    const hook = getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('is idempotent — a second login is a no-op', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    const hook = getSessionAfterHook();

    await hook({ userId: 'real-1' });
    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('does not promote when another real user already exists', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    await insertUser('real-2', { role: 'user', status: 'pending' });
    const hook = getSessionAfterHook();

    await hook({ userId: 'real-2' });

    expect(await getUser('real-2')).toMatchObject({ role: 'user', status: 'pending' });
  });

  it('does not promote when a non-system superadmin exists', async () => {
    await insertUser('admin-1', { role: 'superadmin', status: 'active' });
    await insertUser('real-1', { role: 'user', status: 'active' });
    const hook = getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'user' });
  });

  it('never promotes a suspended user, even as sole operator', async () => {
    await insertUser('real-1', { role: 'user', status: 'suspended' });
    const hook = getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'user', status: 'suspended' });
  });

  it('never mutates the sentinel even if its id is passed as the login user', async () => {
    const hook = getSessionAfterHook();

    await hook({ userId: TRIAL_ANONYMOUS_USER_ID });

    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({ role: 'user', status: 'system' });
  });

  it('honors an env-overridden sentinel id', async () => {
    // Re-seed: a custom sentinel plus the real user. The default sentinel is
    // removed so it cannot satisfy the "single operator" guard on its own.
    await env.DATABASE.prepare(`DELETE FROM users`).run();
    await env.DATABASE.prepare(
      `INSERT INTO users (id, email, email_verified, role, status)
       VALUES ('custom_sentinel', 'c@x.internal', 0, 'user', 'system')`,
    ).run();
    await insertUser('real-1', { role: 'user', status: 'active' });

    const hook = getSessionAfterHook({ TRIAL_ANONYMOUS_USER_ID: 'custom_sentinel' });
    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });
});
