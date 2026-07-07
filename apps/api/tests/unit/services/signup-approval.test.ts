import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingRows = new Map<string, { value: string; updatedAt: string; updatedBy: string | null }>();
let existingUsers: Array<{ id: string }> = [];

const mockDb = {
  select: vi.fn(() => ({
    from: () => ({
      where: () => ({
        get: async () => settingRows.get('signup.requireApproval') ?? undefined,
        limit: () => ({
          all: async () => existingUsers,
        }),
      }),
    }),
  })),
  insert: vi.fn(() => ({
    values: (values: { key: string; value: string; updatedAt: string; updatedBy: string }) => ({
      onConflictDoUpdate: async (options: { set: { value: string; updatedAt: string; updatedBy: string } }) => {
        settingRows.set(values.key, {
          value: options.set.value,
          updatedAt: options.set.updatedAt,
          updatedBy: options.set.updatedBy,
        });
      },
    }),
  })),
};

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => mockDb,
}));

vi.mock('../../../src/services/platform-config', () => ({
  getGitHubOAuthConfig: async (env: { GITHUB_CLIENT_ID?: string; GITHUB_CLIENT_SECRET?: string }) =>
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
      : null,
  getGoogleLoginOAuthConfig: async () => null,
}));

import { createAuth } from '../../../src/auth';
import {
  assertSessionUserApproved,
  getSignupApprovalConfig,
  setSignupApprovalConfig,
} from '../../../src/services/signup-approval';

function testEnv(requireApproval: 'true' | 'false') {
  return {
    DATABASE: {},
    BASE_DOMAIN: 'test.example.com',
    ENCRYPTION_KEY: 'test-encryption-key',
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    REQUIRE_APPROVAL: requireApproval,
  };
}

type UserCreateBeforeHook = (user: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }>;

async function getUserCreateBeforeHook(requireApproval: 'true' | 'false'): Promise<UserCreateBeforeHook> {
  const auth = await createAuth(testEnv(requireApproval) as never);
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

describe('signup approval runtime config', () => {
  beforeEach(() => {
    settingRows.clear();
    existingUsers = [];
    vi.clearAllMocks();
  });

  it('falls back to REQUIRE_APPROVAL when no runtime setting exists', async () => {
    await expect(getSignupApprovalConfig(testEnv('true') as never)).resolves.toMatchObject({
      requireApproval: true,
      source: 'environment',
      updatedAt: null,
      updatedBy: null,
    });
    await expect(getSignupApprovalConfig(testEnv('false') as never)).resolves.toMatchObject({
      requireApproval: false,
      source: 'environment',
    });
  });

  it('persists a runtime override with update metadata', async () => {
    const config = await setSignupApprovalConfig(testEnv('true') as never, {
      requireApproval: false,
      updatedBy: 'admin-1',
    });

    expect(config).toMatchObject({
      requireApproval: false,
      source: 'runtime',
      updatedBy: 'admin-1',
    });
    expect(config.updatedAt).toEqual(expect.any(String));

    await expect(getSignupApprovalConfig(testEnv('true') as never)).resolves.toMatchObject({
      requireApproval: false,
      source: 'runtime',
      updatedBy: 'admin-1',
    });
  });

  it('uses the runtime override for session gate checks', async () => {
    await setSignupApprovalConfig(testEnv('true') as never, {
      requireApproval: false,
      updatedBy: 'admin-1',
    });

    await expect(
      assertSessionUserApproved(testEnv('true') as never, { role: 'user', status: 'pending' }),
    ).resolves.toBeUndefined();

    await setSignupApprovalConfig(testEnv('false') as never, {
      requireApproval: true,
      updatedBy: 'admin-1',
    });

    await expect(
      assertSessionUserApproved(testEnv('false') as never, { role: 'user', status: 'pending' }),
    ).rejects.toMatchObject({ statusCode: 403, error: 'APPROVAL_REQUIRED' });
  });

  it('uses the runtime override in the BetterAuth user creation hook', async () => {
    existingUsers = [{ id: 'existing-user' }];
    await setSignupApprovalConfig(testEnv('true') as never, {
      requireApproval: false,
      updatedBy: 'admin-1',
    });

    const openHook = await getUserCreateBeforeHook('true');
    await expect(openHook({ id: 'new-open-user' })).resolves.toEqual({
      data: { id: 'new-open-user' },
    });

    await setSignupApprovalConfig(testEnv('false') as never, {
      requireApproval: true,
      updatedBy: 'admin-1',
    });

    const gatedHook = await getUserCreateBeforeHook('false');
    await expect(gatedHook({ id: 'new-pending-user' })).resolves.toEqual({
      data: { id: 'new-pending-user', role: 'user', status: 'pending' },
    });
  });
});
