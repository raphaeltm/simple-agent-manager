/**
 * Integration tests for the login-time superadmin self-heal (SAM idea
 * 01KTBCWSTJ83YM280YP7MTE967), exercised against a real Miniflare D1 binding.
 *
 * Three database-backed mechanisms are validated here:
 *   1. Atomic first-signup election and legacy-worker guard triggers (0110).
 *   2. The guarded data migration (0062) — loaded as the genuine SQL artifact via
 *      a Vite `?raw` import and executed against real D1.
 *   3. The `session.create.after` login hook — extracted from a real `createAuth`
 *      instance and invoked against real D1.
 *
 * The sentinel user `system_anonymous_trials` (status='system', seeded by
 * migration 0043) is the orphan that broke first-user promotion. Migration 0110
 * adds a second system row to make the legacy Worker safe during rollout; neither
 * row is ever counted as a "real" user.
 */
import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAuth } from '../../src/auth';
import migrationSql from '../../src/db/migrations/0062_login_time_superadmin_self_heal.sql?raw';
import bootstrapMigrationSql from '../../src/db/migrations/0110_atomic_first_signup_bootstrap.sql?raw';

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

function requiredBootstrapSql(pattern: RegExp, description: string): string {
  const statement = bootstrapMigrationSql.match(pattern)?.[0];
  if (!statement) {
    throw new Error(`Migration 0110 is missing ${description}`);
  }
  return statement;
}

const BOOTSTRAP_SETUP_SQL = [
  requiredBootstrapSql(
    /INSERT INTO users \(id, email, email_verified, role, status\)[\s\S]*?ON CONFLICT\(id\) DO NOTHING;/,
    'the mixed-version guard row'
  ),
  requiredBootstrapSql(
    /CREATE TABLE IF NOT EXISTS first_signup_superadmin_claim[\s\S]*?\n\);/,
    'the durable claim table'
  ),
  requiredBootstrapSql(
    /INSERT INTO first_signup_superadmin_claim[\s\S]*?ON CONFLICT\(singleton\) DO NOTHING;/,
    'the one-time claim initializer'
  ),
  ...(bootstrapMigrationSql.match(/CREATE TRIGGER IF NOT EXISTS[\s\S]*?\nEND;/g) ?? []),
];
const BOOTSTRAP_ELECTION_GUARD_USER_ID = 'system_first_signup_election_guard';

interface UserRow {
  id: string;
  role: string;
  status: string;
}

interface BootstrapClaimRow {
  is_open: number;
  claimed_user_id: string | null;
}

/**
 * Reset the users table to a known baseline: only the two system rows exist.
 * The Miniflare harness auto-applies all migrations (including 0043 which seeds
 * the sentinel and 0062 which is a no-op against the sentinel-only baseline), so
 * we clear any real users left over from prior tests and re-assert the sentinel.
 */
async function resetUsers(): Promise<void> {
  await env.DATABASE.prepare(`DELETE FROM users WHERE status != 'system'`).run();
  await env.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, role, status)
     VALUES (?, 'anonymous-trials@simple-agent-manager.internal', 0, 'user', 'system')
     ON CONFLICT(id) DO UPDATE SET role = 'user', status = 'system'`
  )
    .bind(TRIAL_ANONYMOUS_USER_ID)
    .run();
  await env.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, role, status)
     VALUES (?, 'first-signup-election@simple-agent-manager.internal', 0, 'user', 'system')
     ON CONFLICT(id) DO UPDATE SET role = 'user', status = 'system'`
  )
    .bind(BOOTSTRAP_ELECTION_GUARD_USER_ID)
    .run();
  await env.DATABASE.prepare(
    `UPDATE first_signup_superadmin_claim
     SET is_open = 1, claimed_user_id = NULL
     WHERE singleton = 1`
  ).run();
}

async function insertUser(id: string, opts?: { role?: string; status?: string }): Promise<void> {
  // Insert a non-candidate row, then shape the fixture with UPDATE. Tests in the
  // self-heal and migration sections need to construct pre-existing database
  // states without accidentally exercising migration 0110's INSERT trigger.
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO users (id, email, email_verified, role, status)
       VALUES (?, ?, 1, 'user', 'active')
       ON CONFLICT(id) DO UPDATE SET role = 'user', status = 'active'`
    ).bind(id, `${id}@example.com`),
    env.DATABASE.prepare(`UPDATE users SET role = ?, status = ? WHERE id = ?`).bind(
      opts?.role ?? 'user',
      opts?.status ?? 'active',
      id
    ),
  ]);
}

async function getUser(id: string): Promise<UserRow | null> {
  return env.DATABASE.prepare(`SELECT id, role, status FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
}

async function getRealUsers(): Promise<UserRow[]> {
  const rows = await env.DATABASE.prepare(
    `SELECT id, role, status FROM users WHERE status != 'system' ORDER BY id`
  ).all<UserRow>();
  return rows.results;
}

async function getBootstrapClaim(): Promise<BootstrapClaimRow | null> {
  return env.DATABASE.prepare(
    `SELECT is_open, claimed_user_id
     FROM first_signup_superadmin_claim WHERE singleton = 1`
  ).first<BootstrapClaimRow>();
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
    ENCRYPTION_KEY: 'x'.repeat(32),
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

type UserCreateBeforeHook = (
  user: Record<string, unknown>
) => Promise<{ data: Record<string, unknown> }>;

async function getUserCreateBeforeHook(
  overrides?: Record<string, unknown>
): Promise<UserCreateBeforeHook> {
  const auth = await createAuth(authEnv(overrides) as never);
  const hook = (
    auth.options as {
      databaseHooks?: { user?: { create?: { before?: UserCreateBeforeHook } } };
    }
  ).databaseHooks?.user?.create?.before;
  if (!hook) {
    throw new Error('user.create.before hook was not registered');
  }
  return hook;
}

async function insertHookUser(data: Record<string, unknown>): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, role, status)
     VALUES (?, ?, 1, ?, ?)`
  )
    .bind(data.id, data.email, data.role, data.status)
    .run();
}

async function insertHookAccount(data: Record<string, unknown>): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO accounts (id, account_id, provider_id, user_id)
     VALUES (?, ?, 'github', ?)`
  )
    .bind(`account-${String(data.id)}`, String(data.id), data.id)
    .run();
}

async function createOAuthUser(id: string, overrides?: Record<string, unknown>): Promise<UserRow> {
  const auth = await createAuth(authEnv(overrides) as never);
  const context = await auth.$context;
  const result = await context.internalAdapter.createOAuthUser(
    {
      email: `${id}@example.com`,
      emailVerified: true,
      name: id,
    } as never,
    {
      accountId: id,
      providerId: 'github',
    } as never
  );
  return result.user as UserRow;
}

async function legacyApprovalDecision(
  id: string,
  sentinelId = TRIAL_ANONYMOUS_USER_ID
): Promise<Record<string, unknown>> {
  const existing = await env.DATABASE.prepare(`SELECT id FROM users WHERE id != ? LIMIT 1`)
    .bind(sentinelId)
    .all();
  return {
    id,
    email: `${id}@example.com`,
    role: existing.results.length === 0 ? 'superadmin' : 'user',
    status: existing.results.length === 0 ? 'active' : 'pending',
  };
}

async function applyBootstrapMigration(): Promise<void> {
  expect(BOOTSTRAP_SETUP_SQL).toHaveLength(6);
  for (const statement of BOOTSTRAP_SETUP_SQL) {
    await env.DATABASE.prepare(statement).run();
  }
}

async function removeBootstrapMigrationArtifacts(): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare(`DROP TRIGGER IF EXISTS accounts_claim_first_superadmin_after_insert`),
    env.DATABASE.prepare(
      `DROP TRIGGER IF EXISTS users_normalize_legacy_first_signup_after_insert`
    ),
    env.DATABASE.prepare(`DROP TRIGGER IF EXISTS users_close_first_superadmin_claim_after_update`),
    env.DATABASE.prepare(`DROP TABLE IF EXISTS first_signup_superadmin_claim`),
    env.DATABASE.prepare(`DELETE FROM users WHERE id = ?`).bind(BOOTSTRAP_ELECTION_GUARD_USER_ID),
  ]);
}

describe('first-signup bootstrap election (real D1)', () => {
  beforeEach(resetUsers);

  it('elects exactly one active superadmin after concurrent empty-baseline decisions', async () => {
    const hook = await getUserCreateBeforeHook();
    const candidates = ['concurrent-1', 'concurrent-2', 'concurrent-3'].map((id) => ({
      id,
      email: `${id}@example.com`,
      name: id,
    }));

    // Complete every before-hook read before allowing any insert. This forces the
    // vulnerable interleaving deterministically instead of hoping the scheduler
    // happens to overlap two ordinary signup requests.
    const decisions = await Promise.all(candidates.map((candidate) => hook(candidate)));
    await Promise.all(decisions.map(({ data }) => insertHookUser(data)));
    await Promise.all(decisions.map(({ data }) => insertHookAccount(data)));

    const realUsers = await getRealUsers();
    const superadmins = realUsers.filter(
      (user) => user.role === 'superadmin' && user.status === 'active'
    );
    const pendingUsers = realUsers.filter(
      (user) => user.role === 'user' && user.status === 'pending'
    );

    expect(superadmins).toHaveLength(1);
    expect(pendingUsers).toHaveLength(2);
  });

  it('preserves sequential first-user and later-user approval behavior', async () => {
    const first = await createOAuthUser('sequential-1');
    const later = await createOAuthUser('sequential-2');

    expect(first).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(later).toMatchObject({ role: 'user', status: 'pending' });
    expect(await getRealUsers()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'superadmin', status: 'active' }),
        expect.objectContaining({ role: 'user', status: 'pending' }),
      ])
    );
  });

  it('returns trigger-final roles through the real Better Auth OAuth adapter path', async () => {
    const created = await Promise.all([
      createOAuthUser('oauth-concurrent-1'),
      createOAuthUser('oauth-concurrent-2'),
      createOAuthUser('oauth-concurrent-3'),
    ]);

    expect(
      created.filter((user) => user.role === 'superadmin' && user.status === 'active')
    ).toHaveLength(1);
    expect(
      created.filter((user) => user.role === 'user' && user.status === 'pending')
    ).toHaveLength(2);
    expect(await getRealUsers()).toEqual(
      expect.arrayContaining(
        created.map((user) =>
          expect.objectContaining({ id: user.id, role: user.role, status: user.status })
        )
      )
    );
  });

  it('keeps duplicate/retried before hooks idempotent', async () => {
    const hook = await getUserCreateBeforeHook();
    const candidate = {
      id: 'retried-user',
      email: 'retried-user@example.com',
      name: 'retried-user',
    };

    const [firstDecision, retriedDecision] = await Promise.all([hook(candidate), hook(candidate)]);
    expect(firstDecision).toEqual(retriedDecision);
    await insertHookUser(firstDecision.data);
    await insertHookAccount(firstDecision.data);

    expect(await getUser(candidate.id)).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(await getRealUsers()).toHaveLength(1);
  });

  it('ignores default and custom system sentinels during election', async () => {
    expect(await createOAuthUser('default-sentinel-winner')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });

    await env.DATABASE.prepare(`DELETE FROM users WHERE id != ?`)
      .bind(BOOTSTRAP_ELECTION_GUARD_USER_ID)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO users (id, email, email_verified, role, status)
       VALUES ('custom_sentinel', 'custom@internal.test', 0, 'user', 'system')`
    ).run();
    await env.DATABASE.prepare(
      `UPDATE first_signup_superadmin_claim
       SET is_open = 1, claimed_user_id = NULL
       WHERE singleton = 1`
    ).run();

    expect(
      await createOAuthUser('custom-sentinel-winner', {
        TRIAL_ANONYMOUS_USER_ID: 'custom_sentinel',
      })
    ).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(await getUser('custom_sentinel')).toMatchObject({ role: 'user', status: 'system' });
  });

  it('never promotes suspended rows and does not count them as active operators', async () => {
    await insertUser('suspended-existing', { role: 'superadmin', status: 'suspended' });

    expect(await createOAuthUser('replacement-operator')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
    expect(await getUser('suspended-existing')).toMatchObject({
      role: 'superadmin',
      status: 'suspended',
    });

    await insertUser('suspended-candidate', { role: 'user', status: 'suspended' });
    await insertHookAccount({ id: 'suspended-candidate' });
    expect(await getUser('suspended-candidate')).toMatchObject({
      role: 'user',
      status: 'suspended',
    });
  });

  it('leaves a later signup pending when an active superadmin already exists', async () => {
    await insertUser('existing-admin', { role: 'superadmin', status: 'active' });

    expect(await createOAuthUser('later-user')).toMatchObject({
      role: 'user',
      status: 'pending',
    });
    expect(await getUser('existing-admin')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
  });

  it('recovers when an earlier attempt stops before inserting its user', async () => {
    const hook = await getUserCreateBeforeHook();
    await hook({
      id: 'abandoned-before-insert',
      email: 'abandoned-before-insert@example.com',
      name: 'abandoned-before-insert',
    });

    expect(await createOAuthUser('completed-after-abandon')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
    expect(await getUser('abandoned-before-insert')).toBeNull();
  });

  it('recovers when an earlier attempt inserts a user but never links an account', async () => {
    const hook = await getUserCreateBeforeHook();
    const abandoned = await hook({
      id: 'abandoned-before-account',
      email: 'abandoned-before-account@example.com',
      name: 'abandoned-before-account',
    });
    await insertHookUser(abandoned.data);

    expect(await createOAuthUser('completed-after-orphan')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
    expect(await getUser('abandoned-before-account')).toMatchObject({
      role: 'user',
      status: 'pending',
    });
  });

  it('keeps a completed account-linked election after response interruption', async () => {
    const hook = await getUserCreateBeforeHook();
    const interruptedResponse = await hook({
      id: 'linked-before-interruption',
      email: 'linked-before-interruption@example.com',
      name: 'linked-before-interruption',
    });
    await insertHookUser(interruptedResponse.data);
    await insertHookAccount(interruptedResponse.data);

    expect(await createOAuthUser('completed-later')).toMatchObject({
      role: 'user',
      status: 'pending',
    });
    expect(await getUser('linked-before-interruption')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
  });

  it('does not reopen a completed one-time claim after the operator is suspended', async () => {
    const winner = await createOAuthUser('one-time-winner');
    await env.DATABASE.prepare(
      `UPDATE users SET role = 'superadmin', status = 'suspended' WHERE id = ?`
    )
      .bind(winner.id)
      .run();

    expect(await createOAuthUser('later-after-suspension')).toMatchObject({
      role: 'user',
      status: 'pending',
    });
    expect(await getBootstrapClaim()).toEqual({
      is_open: 0,
      claimed_user_id: winner.id,
    });
  });

  it('makes migration-window legacy decisions safely pending before account election', async () => {
    const candidates = await Promise.all(
      ['legacy-window-1', 'legacy-window-2', 'legacy-window-3'].map((id) =>
        legacyApprovalDecision(id)
      )
    );

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', status: 'pending' }),
        expect.objectContaining({ role: 'user', status: 'pending' }),
        expect.objectContaining({ role: 'user', status: 'pending' }),
      ])
    );
    await Promise.all(candidates.map(insertHookUser));
    await Promise.all(candidates.map(insertHookAccount));

    const users = await getRealUsers();
    expect(
      users.filter((user) => user.role === 'superadmin' && user.status === 'active')
    ).toHaveLength(1);
    expect(users.filter((user) => user.role === 'user' && user.status === 'pending')).toHaveLength(
      2
    );
  });

  it('does not let an interrupted migration-window legacy attempt claim bootstrap', async () => {
    const abandoned = await legacyApprovalDecision('legacy-abandoned-before-account');
    await insertHookUser(abandoned);

    const completed = await legacyApprovalDecision('legacy-completed-later');
    await insertHookUser(completed);
    await insertHookAccount(completed);

    expect(await getUser('legacy-abandoned-before-account')).toMatchObject({
      role: 'user',
      status: 'pending',
    });
    expect(await getUser('legacy-completed-later')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
  });

  it('preserves open registration until login-time self-heal runs', async () => {
    const openUser = await createOAuthUser('open-registration', { REQUIRE_APPROVAL: 'false' });

    expect(openUser).toMatchObject({ role: 'user', status: 'active' });
    expect(await getUser(openUser.id)).toMatchObject({ role: 'user', status: 'active' });

    const loginHook = await getSessionAfterHook({ REQUIRE_APPROVAL: 'false' });
    await loginHook({ userId: openUser.id });
    expect(await getUser(openUser.id)).toMatchObject({ role: 'superadmin', status: 'active' });
    expect(await getBootstrapClaim()).toEqual({
      is_open: 0,
      claimed_user_id: openUser.id,
    });
  });
});

describe('migration 0110 — atomic bootstrap trigger installation (real D1)', () => {
  beforeEach(resetUsers);

  it('is present after a clean migration replay and is idempotent', async () => {
    const before = await env.DATABASE.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'trigger' AND name IN (
         'accounts_claim_first_superadmin_after_insert',
         'users_normalize_legacy_first_signup_after_insert',
         'users_close_first_superadmin_claim_after_update'
       ) ORDER BY name`
    ).all<{ name: string }>();
    expect(before.results.map((row) => row.name)).toEqual([
      'accounts_claim_first_superadmin_after_insert',
      'users_close_first_superadmin_claim_after_update',
      'users_normalize_legacy_first_signup_after_insert',
    ]);

    expect(await getUser(BOOTSTRAP_ELECTION_GUARD_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });

    await applyBootstrapMigration();
    await applyBootstrapMigration();

    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });
    expect(await getBootstrapClaim()).toEqual({ is_open: 1, claimed_user_id: null });
  });

  it('opens exactly once on a clean install while legacy code remains live', async () => {
    await removeBootstrapMigrationArtifacts();

    try {
      await applyBootstrapMigration();
      expect(await getBootstrapClaim()).toEqual({ is_open: 1, claimed_user_id: null });

      const legacyCandidate = await legacyApprovalDecision('clean-legacy-winner');
      expect(legacyCandidate).toMatchObject({ role: 'user', status: 'pending' });
      await insertHookUser(legacyCandidate);
      await insertHookAccount(legacyCandidate);

      expect(await getUser('clean-legacy-winner')).toMatchObject({
        role: 'superadmin',
        status: 'active',
      });
    } finally {
      await applyBootstrapMigration();
    }
  });

  it('normalizes legacy privileged decisions made before migration before electing one account', async () => {
    await removeBootstrapMigrationArtifacts();

    try {
      await env.DATABASE.prepare(
        `DELETE FROM users WHERE status = 'system' AND id != ?`
      )
        .bind(TRIAL_ANONYMOUS_USER_ID)
        .run();

      // This is the deployment-boundary race: both vulnerable before hooks have
      // already observed the empty baseline before 0110 becomes visible.
      const decisions = await Promise.all([
        legacyApprovalDecision('legacy-pre-migration-1'),
        legacyApprovalDecision('legacy-pre-migration-2'),
      ]);
      expect(decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'superadmin', status: 'active' }),
          expect.objectContaining({ role: 'superadmin', status: 'active' }),
        ])
      );

      await applyBootstrapMigration();
      await Promise.all(decisions.map(insertHookUser));

      // The legacy INSERT's RETURNING value cannot be rewritten by SQLite, but
      // the stored rows must already be least-privileged before account linking.
      expect(await getRealUsers()).toEqual([
        { id: 'legacy-pre-migration-1', role: 'user', status: 'pending' },
        { id: 'legacy-pre-migration-2', role: 'user', status: 'pending' },
      ]);

      await Promise.all(decisions.map(insertHookAccount));
      const users = await getRealUsers();
      expect(
        users.filter((user) => user.role === 'superadmin' && user.status === 'active')
      ).toHaveLength(1);
      expect(users.filter((user) => user.role === 'user' && user.status === 'pending')).toHaveLength(
        1
      );
    } finally {
      await applyBootstrapMigration();
    }
  });

  it('closes bootstrap on upgrade and never elevates a later pending newcomer', async () => {
    await removeBootstrapMigrationArtifacts();
    await insertUser('established-ordinary-user', { role: 'user', status: 'active' });

    try {
      await applyBootstrapMigration();
      expect(await getBootstrapClaim()).toEqual({ is_open: 0, claimed_user_id: null });

      const newcomer = await legacyApprovalDecision('established-later-newcomer');
      await insertHookUser(newcomer);
      await insertHookAccount(newcomer);

      expect(await getUser('established-later-newcomer')).toMatchObject({
        role: 'user',
        status: 'pending',
      });
      expect(await getUser('established-ordinary-user')).toMatchObject({
        role: 'user',
        status: 'active',
      });
    } finally {
      await env.DATABASE.prepare(`DELETE FROM users WHERE id = 'established-ordinary-user'`).run();
      await applyBootstrapMigration();
    }
  });
});

describe('migration 0062 — guarded superadmin backfill (real D1)', () => {
  beforeEach(resetUsers);

  it('promotes the sole real user when only the sentinel co-exists', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });

    await env.DATABASE.exec(MIGRATION_UPDATE_SQL);

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
    // Sentinel is never touched.
    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });
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

    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });
    const superadmins = await env.DATABASE.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'`
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
    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });
  });

  it('runs self-heal through the real Better Auth session adapter path', async () => {
    await insertUser('real-session-path', { role: 'user', status: 'active' });
    const auth = await createAuth(authEnv() as never);
    const context = await auth.$context;

    const session = await context.internalAdapter.createSession('real-session-path', false);

    expect(session).toMatchObject({ userId: 'real-session-path' });
    expect(await getUser('real-session-path')).toMatchObject({
      role: 'superadmin',
      status: 'active',
    });
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

  it('never promotes a suspended user, even as sole operator', async () => {
    await insertUser('real-1', { role: 'user', status: 'suspended' });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'user', status: 'suspended' });
  });

  it('promotes a sole pending user on login (edge case 10)', async () => {
    await insertUser('real-1', { role: 'user', status: 'pending' });
    const hook = await getSessionAfterHook();

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('promotes the sole user even when REQUIRE_APPROVAL is unset (open registration)', async () => {
    await insertUser('real-1', { role: 'user', status: 'active' });
    // Omit REQUIRE_APPROVAL entirely — the self-heal is ungated and must still fire.
    const hook = await getSessionAfterHook({ REQUIRE_APPROVAL: undefined });

    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });

  it('never mutates the sentinel even if its id is passed as the login user', async () => {
    const hook = await getSessionAfterHook();

    await hook({ userId: TRIAL_ANONYMOUS_USER_ID });

    expect(await getUser(TRIAL_ANONYMOUS_USER_ID)).toMatchObject({
      role: 'user',
      status: 'system',
    });
  });

  it('honors an env-overridden sentinel id', async () => {
    // Re-seed: a custom sentinel plus the real user. The default sentinel is
    // removed so it cannot satisfy the "single operator" guard on its own.
    await env.DATABASE.prepare(`DELETE FROM users`).run();
    await env.DATABASE.prepare(
      `INSERT INTO users (id, email, email_verified, role, status)
       VALUES ('custom_sentinel', 'c@x.internal', 0, 'user', 'system')`
    ).run();
    await insertUser('real-1', { role: 'user', status: 'active' });

    const hook = await getSessionAfterHook({ TRIAL_ANONYMOUS_USER_ID: 'custom_sentinel' });
    await hook({ userId: 'real-1' });

    expect(await getUser('real-1')).toMatchObject({ role: 'superadmin', status: 'active' });
  });
});
