import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { selectPrimaryGitHubEmail } from '../../src/auth';

interface AuthTestUser {
  id: string;
  email: string;
  name: string;
  role?: string;
  status?: string;
}

type BeforeCreateHook = (user: AuthTestUser) => Promise<{ data: AuthTestUser }>;
type SessionAfterHook = (session: { userId?: string | null }) => Promise<void>;

interface BetterAuthOptions {
  account?: { encryptOAuthTokens?: boolean };
  databaseHooks?: {
    user?: {
      create?: {
        before?: BeforeCreateHook;
      };
    };
    session?: {
      create?: {
        after?: SessionAfterHook;
      };
    };
  };
}

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(() => ({})),
}));

// Capture the options passed to betterAuth so we can assert on config
let capturedOptions: BetterAuthOptions | undefined;

vi.mock('better-auth', () => ({
  betterAuth: (opts: BetterAuthOptions) => {
    capturedOptions = opts;
    return { options: opts, handler: vi.fn(), api: {}, $context: Promise.resolve({}) };
  },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: mocks.drizzle,
}));

function fakeEnv(requireApproval = 'true') {
  return {
    DATABASE: {},
    BASE_DOMAIN: 'example.com',
    ENCRYPTION_KEY: 'test-key',
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    REQUIRE_APPROVAL: requireApproval,
  };
}

function installExistingUsersQuery(existingUsers: Array<{ id: string }>) {
  const all = vi.fn(async () => existingUsers);
  const limit = vi.fn(() => ({ all }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  mocks.drizzle.mockReturnValue({ select });

  return { all, from, limit, select, where };
}

async function getBeforeCreateHook(): Promise<BeforeCreateHook> {
  const { createAuth } = await import('../../src/auth');
  createAuth(fakeEnv() as never);

  const hook = capturedOptions?.databaseHooks?.user?.create?.before;
  if (!hook) {
    throw new Error('BetterAuth user.create.before hook was not registered');
  }

  return hook;
}

/**
 * Build a fake D1 binding whose prepare().bind().run() chain records the SQL and
 * bound parameters, and returns a configurable `meta.changes` (or throws).
 */
function makeSelfHealDb(opts?: { changes?: number; throwOnRun?: boolean }) {
  const run = vi.fn(async () => {
    if (opts?.throwOnRun) {
      throw new Error('D1_ERROR: simulated failure');
    }
    return { meta: { changes: opts?.changes ?? 0 } };
  });
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { db: { prepare }, prepare, bind, run };
}

async function getSessionAfterHook(env: Record<string, unknown>): Promise<SessionAfterHook> {
  const { createAuth } = await import('../../src/auth');
  createAuth(env as never);

  const hook = capturedOptions?.databaseHooks?.session?.create?.after;
  if (!hook) {
    throw new Error('BetterAuth session.create.after hook was not registered');
  }

  return hook;
}

const newUser: AuthTestUser = {
  id: 'github-user-1',
  email: 'user@example.com',
  name: 'Test User',
};

describe('BetterAuth configuration', () => {
  beforeEach(() => {
    capturedOptions = undefined;
    mocks.drizzle.mockReset();
    mocks.drizzle.mockReturnValue({});
  });

  it('enables OAuth token encryption (encryptOAuthTokens: true)', async () => {
    const { createAuth } = await import('../../src/auth');

    createAuth(fakeEnv() as never);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.account?.encryptOAuthTokens).toBe(true);
  });

  it('promotes the first real user when only the trial sentinel exists', async () => {
    const query = installExistingUsersQuery([]);
    const beforeCreate = await getBeforeCreateHook();

    const result = await beforeCreate(newUser);

    expect(result.data).toMatchObject({
      id: newUser.id,
      role: 'superadmin',
      status: 'active',
    });
    expect(query.where).toHaveBeenCalledOnce();
    expect(query.all).toHaveBeenCalledOnce();
  });

  it('keeps later real users pending when the sentinel and a real user exist', async () => {
    installExistingUsersQuery([{ id: 'real-user-1' }]);
    const beforeCreate = await getBeforeCreateHook();

    const result = await beforeCreate(newUser);

    expect(result.data).toMatchObject({
      id: newUser.id,
      role: 'user',
      status: 'pending',
    });
  });

  it('uses the shared trial sentinel user id in tests', () => {
    expect(TRIAL_ANONYMOUS_USER_ID).toBe('system_anonymous_trials');
  });
});

describe('login-time superadmin self-heal (session.create.after)', () => {
  beforeEach(() => {
    capturedOptions = undefined;
    mocks.drizzle.mockReset();
    mocks.drizzle.mockReturnValue({});
  });

  it('registers a session.create.after hook', async () => {
    const { db } = makeSelfHealDb();
    await getSessionAfterHook({ ...fakeEnv(), DATABASE: db });
    // getSessionAfterHook throws if the hook is missing, so reaching here is the assertion.
    expect(capturedOptions?.databaseHooks?.session?.create?.after).toBeTypeOf('function');
  });

  it('runs the guarded UPDATE bound to (userId, sentinelId) on login', async () => {
    const { db, prepare, bind, run } = makeSelfHealDb({ changes: 1 });
    const hook = await getSessionAfterHook({ ...fakeEnv(), DATABASE: db });

    await hook({ userId: 'github-user-1' });

    expect(prepare).toHaveBeenCalledOnce();
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE users');
    expect(sql).toContain("role = 'superadmin'");
    // The guard set is load-bearing — without every clause the UPDATE would
    // over-promote. Assert each guard is present so a future edit cannot silently
    // drop one (substring checks here complement the real-D1 workers integration
    // tests that execute the statement against actual rows).
    expect(sql).toContain('WHERE id = ?1'); // only ever the signing-in user
    expect(sql).toContain("role != 'superadmin'"); // idempotent
    expect(sql).toContain("status != 'system'"); // never touch the sentinel
    expect(sql).toContain("status != 'suspended'"); // never auto-elevate a suspended user
    // Exactly-one-real-user guard: count other non-system, non-sentinel users.
    expect(sql).toContain('u2.status != ');
    expect(sql).toContain('u2.id != ?2');
    // No-existing-superadmin guard.
    expect(sql).toContain("u3.role = 'superadmin'");
    // ?1 = current user id (referenced twice), ?2 = sentinel id.
    expect(bind).toHaveBeenCalledWith('github-user-1', TRIAL_ANONYMOUS_USER_ID);
    expect(run).toHaveBeenCalledOnce();
  });

  it('honors an env-overridden sentinel id when binding', async () => {
    const { db, bind } = makeSelfHealDb({ changes: 0 });
    const hook = await getSessionAfterHook({
      ...fakeEnv(),
      DATABASE: db,
      TRIAL_ANONYMOUS_USER_ID: 'custom_sentinel',
    });

    await hook({ userId: 'github-user-1' });

    expect(bind).toHaveBeenCalledWith('github-user-1', 'custom_sentinel');
  });

  it('does nothing (no query) when the session userId is null', async () => {
    const { db, prepare } = makeSelfHealDb();
    const hook = await getSessionAfterHook({ ...fakeEnv(), DATABASE: db });

    await hook({ userId: null });

    expect(prepare).not.toHaveBeenCalled();
  });

  it('does nothing (no query) when the session userId is undefined', async () => {
    const { db, prepare } = makeSelfHealDb();
    const hook = await getSessionAfterHook({ ...fakeEnv(), DATABASE: db });

    await hook({ userId: undefined });

    expect(prepare).not.toHaveBeenCalled();
  });

  it('swallows a D1 failure so login still succeeds (load-bearing try/catch)', async () => {
    const { db } = makeSelfHealDb({ throwOnRun: true });
    const hook = await getSessionAfterHook({ ...fakeEnv(), DATABASE: db });

    // Must resolve, not reject — an uncaught throw here would surface as a 500
    // and break login, since better-auth awaits session.create.after.
    await expect(hook({ userId: 'github-user-1' })).resolves.toBeUndefined();
  });
});

describe('GitHub auth email selection', () => {
  it('prefers verified primary email from email list', () => {
    const selected = selectPrimaryGitHubEmail('12345+octocat@users.noreply.github.com', [
      { email: 'secondary@real-company.com', primary: false, verified: true },
      { email: 'octocat@real-company.com', primary: false, verified: true },
      { email: 'primary@real-company.com', primary: true, verified: true },
    ]);

    expect(selected).toBe('primary@real-company.com');
  });

  it('returns primary email even when non-primary verified email exists', () => {
    const selected = selectPrimaryGitHubEmail('12345+octocat@users.noreply.github.com', [
      { email: '12345+octocat@users.noreply.github.com', primary: true, verified: true },
      { email: 'octocat@real-company.com', primary: false, verified: true },
    ]);

    expect(selected).toBe('12345+octocat@users.noreply.github.com');
  });

  it('falls back to primary email when it is not verified', () => {
    const selected = selectPrimaryGitHubEmail('12345+octocat@users.noreply.github.com', [
      { email: 'octocat@real-company.com', primary: true, verified: false },
    ]);

    expect(selected).toBe('octocat@real-company.com');
  });

  it('falls back to user email when email list has no primary entry', () => {
    const selected = selectPrimaryGitHubEmail('public@profile.com', [
      { email: 'octocat@real-company.com', primary: false, verified: true },
    ]);

    expect(selected).toBe('public@profile.com');
  });
});
