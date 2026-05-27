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

interface BetterAuthOptions {
  account?: { encryptOAuthTokens?: boolean };
  databaseHooks?: {
    user?: {
      create?: {
        before?: BeforeCreateHook;
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
