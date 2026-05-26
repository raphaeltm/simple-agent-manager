import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { githubRoutes } from '../../../src/routes/github';
import {
  getAuthenticatedUserOrganizations,
  getUserAccessibleInstallations,
  verifyUserInstallationAccess,
  verifyWebhookSignature,
} from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getAuthenticatedUserOrganizations: vi.fn(),
  getUserAccessibleInstallations: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  verifyUserInstallationAccess: vi.fn(),
  optionalAuthUser: null as null | {
    id: string;
    role: string;
    status: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  },
  insertError: null as unknown,
  insertErrorTable: 'all' as 'all' | 'githubInstallations' | 'githubInstallationAccounts',
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
}));
vi.mock('../../../src/auth', () => ({
  createAuth: () => ({
    api: {
      getAccessToken: mocks.getAccessToken,
    },
  }),
}));
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', role: 'user', status: 'active', email: 'u@example.com', name: 'User', avatarUrl: null },
      session: { id: 'sess-1', expiresAt: new Date() },
    });
    return next();
  }),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  optionalAuth: () => vi.fn((c: any, next: any) => {
    if (mocks.optionalAuthUser) {
      c.set('auth', {
        user: mocks.optionalAuthUser,
        session: { id: 'sess-1', expiresAt: new Date() },
      });
    }
    return next();
  }),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/services/github-app', async () => {
  const actual = await vi.importActual<typeof import('../../../src/services/github-app')>(
    '../../../src/services/github-app'
  );
  return {
    ...actual,
    getAuthenticatedUserOrganizations: mocks.getAuthenticatedUserOrganizations,
    getUserAccessibleInstallations: mocks.getUserAccessibleInstallations,
    verifyWebhookSignature: mocks.verifyWebhookSignature,
    verifyUserInstallationAccess: mocks.verifyUserInstallationAccess,
    getInstallationRepositories: vi.fn(),
    getRepositoryBranches: vi.fn(),
  };
});

describe('GitHub App installation sharing', () => {
  let app: Hono<{ Bindings: Env }>;
  let whereResponses: unknown[][];
  let limitResponses: unknown[][];
  let insertedRows: unknown[];
  let deleteResponses: unknown[][];
  let deletedTables: unknown[];
  const mockEnv = {
    DATABASE: {} as D1Database,
    BASE_DOMAIN: 'example.com',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_APP_ID: 'app-id',
    GITHUB_APP_PRIVATE_KEY: 'key',
    ENCRYPTION_KEY: 'webhook-secret',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    whereResponses = [];
    limitResponses = [];
    insertedRows = [];
    deleteResponses = [];
    deletedTables = [];
    mocks.optionalAuthUser = { id: 'user-1', role: 'user', status: 'active', email: 'u@example.com', name: 'User', avatarUrl: null };
    mocks.insertError = null;
    mocks.insertErrorTable = 'all';
    mocks.getAccessToken.mockResolvedValue({ accessToken: 'github-user-token' });
    mocks.getAuthenticatedUserOrganizations.mockResolvedValue([]);
    mocks.getUserAccessibleInstallations.mockResolvedValue([]);
    mocks.verifyUserInstallationAccess.mockResolvedValue(true);
    mocks.verifyWebhookSignature.mockResolvedValue(true);

    const makeSelectBuilder = () => {
      const fromBuilder = {
        where: vi.fn(() =>
          Object.assign(Promise.resolve(whereResponses.shift() ?? []), {
            limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
          })
        ),
      };
      return {
        from: vi.fn(() => fromBuilder),
      };
    };

    const tableNameForInsert = (table: unknown) => {
      if (table === schema.githubInstallations) return 'githubInstallations';
      if (table === schema.githubInstallationAccounts) return 'githubInstallationAccounts';
      return 'other';
    };

    const makeInsertBuilder = (table: unknown) => ({
      values: vi.fn((row: unknown) => {
        const tableName = tableNameForInsert(table);
        if (
          mocks.insertError &&
          (mocks.insertErrorTable === 'all' || mocks.insertErrorTable === tableName)
        ) {
          throw mocks.insertError;
        }
        insertedRows.push(row);
        return {
          onConflictDoUpdate: vi.fn(() => Promise.resolve(undefined)),
          onConflictDoNothing: vi.fn(() => Promise.resolve(undefined)),
        };
      }),
    });

    const makeDeleteBuilder = (table: unknown) => {
      deletedTables.push(table);
      const whereResult = Object.assign(Promise.resolve(deleteResponses.shift() ?? []), {
        returning: vi.fn(() => Promise.resolve(deleteResponses.shift() ?? [])),
      });
      return {
        where: vi.fn(() => whereResult),
      };
    };

    const mockDB = {
      select: vi.fn(() => makeSelectBuilder()),
      insert: vi.fn((table: unknown) => makeInsertBuilder(table)),
      delete: vi.fn((table: unknown) => makeDeleteBuilder(table)),
    };

    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDB);

    app = new Hono<{ Bindings: Env }>();
    app.route('/api/github', githubRoutes);
  });

  const expectTokenNotLogged = (token: string) => {
    const allLogCalls = JSON.stringify([
      mocks.log.debug.mock.calls,
      mocks.log.info.mock.calls,
      mocks.log.warn.mock.calls,
      mocks.log.error.mock.calls,
    ]);
    expect(allLogCalls).not.toContain(token);
  };

  const accessibleAcmeInstallation = () => [
    { id: 123, account: { login: 'acme', type: 'Organization' } },
  ];

  const existingInstallationRow = () => ({
    id: 'inst-row-111',
    userId: 'user-1',
    installationId: '111',
    accountType: 'organization',
    accountName: 'existing',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
  });

  const sharedEffpropCandidateRow = () => ({
    installationId: '120081765',
    accountType: 'organization',
    accountName: 'effprop',
    accountNameNormalized: 'effprop',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    uninstalledAt: null,
  });

  const sharedEffpropCurrentUserRow = () => ({
    ...sharedEffpropCandidateRow(),
    id: 'inst-row-effprop-user-1',
    userId: 'user-1',
  });

  const mockSyncInsertFailure = (error: Error) => {
    whereResponses.push([{ installationId: '111' }], [existingInstallationRow()]);
    mocks.insertError = error;
    mocks.insertErrorTable = 'githubInstallations';
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 111, account: { login: 'existing', type: 'Organization' } },
      { id: 222, account: { login: 'acme', type: 'Organization' } },
    ]);
  };

  const expectOnlyExistingInstallation = async (res: Response) => {
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
    ]);
  };

  const callbackInsertFailure = async (error: Error) => {
    limitResponses.push([]);
    mocks.insertError = error;
    mocks.insertErrorTable = 'githubInstallations';
    mocks.getUserAccessibleInstallations.mockResolvedValue(accessibleAcmeInstallation());

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=installation_save_failed'
    );
  };

  const insertedPerUserRows = () =>
    insertedRows.filter((row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && 'userId' in row
    );

  const insertedCanonicalRows = () =>
    insertedRows.filter((row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null && 'accountNameNormalized' in row
    );

  it('stores callback installation only when the GitHub user can access it', async () => {
    limitResponses.push([]);
    mocks.getUserAccessibleInstallations.mockResolvedValue(accessibleAcmeInstallation());

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example.com/settings?github_app=installed');
    expect(insertedCanonicalRows()).toEqual([
      expect.objectContaining({
        installationId: '123',
        accountType: 'organization',
        accountName: 'acme',
        accountNameNormalized: 'acme',
        uninstalledAt: null,
      }),
    ]);
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      installationId: 'user-1:123',
      externalInstallationId: '123',
      accountType: 'organization',
      accountName: 'acme',
    });
    expect(getUserAccessibleInstallations).toHaveBeenCalledWith('github-user-token', {
      flow: 'callback',
      userId: 'user-1',
      installationId: '123',
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.received', {
      userId: 'user-1',
      authenticated: true,
      installationId: '123',
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.token_status', {
      userId: 'user-1',
      installationId: '123',
      tokenPresent: true,
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.accessible_installations', {
      userId: 'user-1',
      installationId: '123',
      installationCount: 1,
      installations: [{ installationId: '123', accountName: 'acme', accountType: 'Organization' }],
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.installation_match', {
      userId: 'user-1',
      installationId: '123',
      found: true,
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.insert_result', {
      userId: 'user-1',
      installationId: '123',
      result: 'success',
      accountName: 'acme',
      accountType: 'Organization',
    });
  });

  it('rejects spoofed callback installation IDs not accessible to the GitHub user', async () => {
    limitResponses.push([]);
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 456, account: { login: 'other-org', type: 'Organization' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=installation_not_accessible'
    );
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.installation_match', {
      userId: 'user-1',
      installationId: '123',
      found: false,
    });
  });

  it('logs unauthenticated callbacks before redirecting back to app login', async () => {
    mocks.optionalAuthUser = null;

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example.com/?installation_id=123');
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.received', {
      userId: undefined,
      authenticated: false,
      installationId: '123',
    });
    expect(mocks.log.warn).toHaveBeenCalledWith('github.installation_callback.unauthenticated', {
      authenticated: false,
      installationId: '123',
    });
  });

  it('logs callback insert conflicts without exposing token values', async () => {
    await callbackInsertFailure(
      new Error('UNIQUE constraint failed: github_installations.user_id, installation_id')
    );
    expect(mocks.log.warn).toHaveBeenCalledWith('github.installation_callback.insert_result', {
      userId: 'user-1',
      installationId: '123',
      result: 'conflict',
      error: 'UNIQUE constraint failed: github_installations.user_id, installation_id',
    });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain('github-user-token');
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('github-user-token');
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('github-user-token');
  });

  it('logs callback insert errors separately from conflicts', async () => {
    await callbackInsertFailure(new Error('D1 write unavailable'));
    expect(mocks.log.error).toHaveBeenCalledWith('github.installation_callback.insert_result', {
      userId: 'user-1',
      installationId: '123',
      result: 'error',
      error: 'D1 write unavailable',
    });
    expectTokenNotLogged('github-user-token');
  });

  it('logs callback token-unavailable diagnostics and skips GitHub installation lookup', async () => {
    limitResponses.push([]);
    mocks.getAccessToken.mockResolvedValue({ accessToken: '', scopes: [] });

    const res = await app.request('/api/github/callback?installation_id=123', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=github_user_token_unavailable'
    );
    expect(mocks.log.info).toHaveBeenCalledWith('github.user_access_token.lookup', {
      userId: 'user-1',
      tokenPresent: false,
      tokenType: null,
      scopes: [],
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installation_callback.token_status', {
      userId: 'user-1',
      installationId: '123',
      tokenPresent: false,
    });
    expect(mocks.getUserAccessibleInstallations).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
  });

  it('logs BetterAuth token lookup failures without logging token values', async () => {
    mocks.getAccessToken.mockRejectedValue(new Error('BetterAuth unavailable'));

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.log.warn).toHaveBeenCalledWith('github.user_access_token_unavailable', {
      userId: 'user-1',
      tokenPresent: false,
      error: 'BetterAuth unavailable',
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.token_status', {
      userId: 'user-1',
      tokenPresent: false,
    });
    expect(mocks.getUserAccessibleInstallations).not.toHaveBeenCalled();
  });

  it('syncs missing per-user installation rows from user-context GitHub access', async () => {
    whereResponses.push(
      [{ installationId: '111' }],
      [
        {
          id: 'inst-row-111',
          userId: 'user-1',
          installationId: '111',
          accountType: 'organization',
          accountName: 'existing',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
        {
          id: 'inst-row-222',
          userId: 'user-1',
          installationId: '222',
          accountType: 'organization',
          accountName: 'acme',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ]
    );
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 111, account: { login: 'existing', type: 'Organization' } },
      { id: 222, account: { login: 'acme', type: 'Organization' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedCanonicalRows()).toEqual([
      expect.objectContaining({
        installationId: '111',
        accountName: 'existing',
        accountNameNormalized: 'existing',
      }),
      expect.objectContaining({
        installationId: '222',
        accountName: 'acme',
        accountNameNormalized: 'acme',
      }),
    ]);
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      installationId: 'user-1:222',
      externalInstallationId: '222',
      accountType: 'organization',
      accountName: 'acme',
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.token_status', {
      userId: 'user-1',
      tokenPresent: true,
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.accessible_installations', {
      userId: 'user-1',
      installationCount: 2,
      installations: [
        { installationId: '111', accountName: 'existing', accountType: 'Organization' },
        { installationId: '222', accountName: 'acme', accountType: 'Organization' },
      ],
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.missing_installations', {
      userId: 'user-1',
      missingInstallationCount: 1,
      installations: [{ installationId: '222', accountName: 'acme', accountType: 'Organization' }],
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.insert_result', {
      userId: 'user-1',
      installationId: '222',
      result: 'success',
      accountName: 'acme',
      accountType: 'Organization',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
      expect.objectContaining({ installationId: '222' }),
    ]);
  });

  it('discovers a known org installation when org membership and installation verification succeed', async () => {
    whereResponses.push([], [sharedEffpropCandidateRow()], [sharedEffpropCurrentUserRow()]);
    mocks.getAuthenticatedUserOrganizations.mockResolvedValue([{ login: 'effprop' }]);
    mocks.verifyUserInstallationAccess.mockResolvedValue(true);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(getAuthenticatedUserOrganizations).toHaveBeenCalledWith('github-user-token', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
    });
    expect(verifyUserInstallationAccess).toHaveBeenCalledWith('github-user-token', '120081765', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
    });
    expect(insertedCanonicalRows()).toHaveLength(0);
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      installationId: 'user-1:120081765',
      externalInstallationId: '120081765',
      accountType: 'organization',
      accountName: 'effprop',
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.shared_org_installations.insert_result', {
      userId: 'user-1',
      installationId: '120081765',
      result: 'success',
      accountName: 'effprop',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '120081765', userId: 'user-1' }),
    ]);
  });

  it('does not verify or insert known org installations outside the user org memberships', async () => {
    whereResponses.push([], [], [existingInstallationRow()]);
    mocks.getAuthenticatedUserOrganizations.mockResolvedValue([{ login: 'not-effprop' }]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(verifyUserInstallationAccess).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
    ]);
  });

  it('skips shared org candidates when installation-specific user verification denies access', async () => {
    whereResponses.push([], [sharedEffpropCandidateRow()], [existingInstallationRow()]);
    mocks.getAuthenticatedUserOrganizations.mockResolvedValue([{ login: 'effprop' }]);
    mocks.verifyUserInstallationAccess.mockResolvedValue(false);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith('github.shared_org_installations.verification_skipped', {
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
      reason: 'not_accessible_to_user',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
    ]);
  });

  it('does not let shared org discovery errors erase or block current installations', async () => {
    whereResponses.push([existingInstallationRow()]);
    mocks.getAuthenticatedUserOrganizations.mockRejectedValue(new Error('GitHub org lookup timeout'));

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.error).toHaveBeenCalledWith('github.shared_org_installations.failed', {
      userId: 'user-1',
      error: 'GitHub org lookup timeout',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
    ]);
  });

  it('unlinks only the current user per-user installation row', async () => {
    deleteResponses.push([], [{ id: 'inst-row-effprop-user-1' }]);

    const res = await app.request('/api/github/installations/inst-row-effprop-user-1', {
      method: 'DELETE',
    }, mockEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true });
    expect(deletedTables).toEqual([schema.githubInstallations]);
    expect(insertedCanonicalRows()).toHaveLength(0);
  });

  it('records canonical state from installation-created webhook even without a SAM user link', async () => {
    limitResponses.push([]);
    const payload = JSON.stringify({
      action: 'created',
      installation: {
        id: 120081765,
        account: { login: 'effprop', type: 'Organization' },
      },
      sender: { id: 987654 },
    });

    const res = await app.request('/api/github/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': 'sha256=test',
        'x-github-event': 'installation',
        'content-type': 'application/json',
      },
      body: payload,
    }, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedCanonicalRows()).toEqual([
      expect.objectContaining({
        installationId: '120081765',
        accountType: 'organization',
        accountName: 'effprop',
        accountNameNormalized: 'effprop',
        uninstalledAt: null,
      }),
    ]);
    expect(insertedPerUserRows()).toHaveLength(0);
  });

  it('tombstones canonical state and removes per-user links on GitHub uninstall webhook', async () => {
    const payload = JSON.stringify({
      action: 'deleted',
      installation: {
        id: 120081765,
        account: { login: 'effprop', type: 'Organization' },
      },
    });

    const res = await app.request('/api/github/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': 'sha256=test',
        'x-github-event': 'installation',
        'content-type': 'application/json',
      },
      body: payload,
    }, mockEnv);

    expect(res.status).toBe(200);
    expect(verifyWebhookSignature).toHaveBeenCalledWith(payload, 'sha256=test', expect.any(String));
    expect(insertedCanonicalRows()).toEqual([
      expect.objectContaining({
        installationId: '120081765',
        accountType: 'organization',
        accountName: 'effprop',
        accountNameNormalized: 'effprop',
      }),
    ]);
    const tombstonedCanonicalRow = insertedCanonicalRows()[0];
    expect(tombstonedCanonicalRow?.uninstalledAt).toEqual(expect.any(String));
    expect(deletedTables).toEqual([schema.githubInstallations]);
  });

  it('logs sync insert conflicts without blocking the installations response', async () => {
    mockSyncInsertFailure(
      new Error('UNIQUE constraint failed: github_installations.user_id, installation_id')
    );

    const res = await app.request('/api/github/installations', {}, mockEnv);

    await expectOnlyExistingInstallation(res);
    expect(mocks.log.warn).toHaveBeenCalledWith('github.installations_sync.insert_result', {
      userId: 'user-1',
      installationId: '222',
      result: 'conflict',
      accountName: 'acme',
      accountType: 'Organization',
      error: 'UNIQUE constraint failed: github_installations.user_id, installation_id',
    });
  });

  it('logs sync insert errors without blocking the installations response', async () => {
    mockSyncInsertFailure(new Error('D1 write unavailable'));

    const res = await app.request('/api/github/installations', {}, mockEnv);

    await expectOnlyExistingInstallation(res);
    expect(mocks.log.error).toHaveBeenCalledWith('github.installations_sync.insert_result', {
      userId: 'user-1',
      installationId: '222',
      result: 'error',
      accountName: 'acme',
      accountType: 'Organization',
      error: 'D1 write unavailable',
    });
  });

  it('logs BetterAuth token metadata without logging the token value', async () => {
    whereResponses.push([], []);
    mocks.getAccessToken.mockResolvedValue({
      accessToken: 'github-user-token',
      tokenType: 'bearer',
      scopes: ['read:user', 'repo'],
    });
    mocks.getUserAccessibleInstallations.mockResolvedValue([]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(mocks.log.info).toHaveBeenCalledWith('github.user_access_token.lookup', {
      userId: 'user-1',
      tokenPresent: true,
      tokenType: 'bearer',
      scopes: ['read:user', 'repo'],
    });
    expectTokenNotLogged('github-user-token');
  });
});
