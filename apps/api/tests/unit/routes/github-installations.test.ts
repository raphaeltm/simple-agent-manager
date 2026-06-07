import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { githubRoutes } from '../../../src/routes/github';
import {
  getAuthenticatedGitHubUser,
  getAuthenticatedUserOrganizations,
  getRepositoryBranches,
  getUserAccessibleInstallations,
  getUserInstallationRepositories,
  verifyUserInstallationAccess,
  verifyWebhookSignature,
} from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getAuthenticatedGitHubUser: vi.fn(),
  getAuthenticatedUserOrganizations: vi.fn(),
  getUserAccessibleInstallations: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
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
    getAuthenticatedGitHubUser: mocks.getAuthenticatedGitHubUser,
    getAuthenticatedUserOrganizations: mocks.getAuthenticatedUserOrganizations,
    getUserAccessibleInstallations: mocks.getUserAccessibleInstallations,
    getUserInstallationRepositories: mocks.getUserInstallationRepositories,
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
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getAuthenticatedUserOrganizations.mockResolvedValue([]);
    mocks.getUserAccessibleInstallations.mockResolvedValue([]);
    mocks.getUserInstallationRepositories.mockResolvedValue([]);
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
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
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
    { id: 123, account: { id: 12345, login: 'acme', type: 'Organization' } },
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
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 111, account: { id: 11100, login: 'existing', type: 'Organization' } },
      { id: 113789898, account: { id: 591860, login: 'lionello', type: 'User' } },
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

  const postInstallationWebhook = (payload: string) =>
    app.request('/api/github/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': 'sha256=test',
        'x-github-event': 'installation',
        'content-type': 'application/json',
      },
      body: payload,
    }, mockEnv);

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

  it('rejects callback personal installations owned by a different GitHub user', async () => {
    limitResponses.push([]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 108667778, account: { id: 910895, login: 'raphaeltm', type: 'User' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=108667778', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=installation_not_accessible'
    );
    expect(getAuthenticatedGitHubUser).toHaveBeenCalledWith('github-user-token', {
      flow: 'callback',
      userId: 'user-1',
    });
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith('github.personal_installation_owner_mismatch', {
      installationId: '108667778',
      userId: 'user-1',
      authenticatedGitHubUserId: 591860,
      authenticatedGitHubLogin: 'lionello',
      installationAccountId: 910895,
      installationAccountLogin: 'raphaeltm',
    });
  });

  it('rejects and deletes an existing callback personal row owned by a different GitHub user', async () => {
    limitResponses.push([{
      id: 'bad-row-1',
      userId: 'user-1',
      installationId: 'user-1:108667778',
      externalInstallationId: '108667778',
      accountType: 'personal',
      accountName: 'raphaeltm',
      createdAt: '2026-06-06T16:41:10.502Z',
      updatedAt: '2026-06-06T16:41:10.502Z',
    }]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 108667778, account: { id: 910895, login: 'raphaeltm', type: 'User' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=108667778', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=installation_not_accessible'
    );
    expect(deletedTables).toEqual([schema.githubInstallations]);
    expect(insertedRows).toHaveLength(0);
  });

  it('rejects callback personal owner mismatch when GitHub omits account id', async () => {
    limitResponses.push([]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 108667778, account: { login: 'raphaeltm', type: 'User' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=108667778', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example.com/settings?github_app=error&reason=installation_not_accessible'
    );
    expect(insertedRows).toHaveLength(0);
  });

  it('stores callback personal installations owned by the authenticated GitHub user', async () => {
    limitResponses.push([]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 113789898, account: { id: 591860, login: 'lionello', type: 'User' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=113789898', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example.com/settings?github_app=installed');
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      installationId: 'user-1:113789898',
      externalInstallationId: '113789898',
      accountType: 'personal',
      accountName: 'lionello',
    });
  });

  it('stores callback personal installations by case-insensitive login when GitHub omits account id', async () => {
    limitResponses.push([]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'Lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 113789898, account: { login: 'lionello', type: 'User' } },
    ]);

    const res = await app.request('/api/github/callback?installation_id=113789898', {}, mockEnv);

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://app.example.com/settings?github_app=installed');
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      externalInstallationId: '113789898',
      accountType: 'personal',
      accountName: 'lionello',
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

  it('does not direct-sync shared organization installations from user-context GitHub access', async () => {
    whereResponses.push([existingInstallationRow()]);
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 111, account: { id: 11100, login: 'existing', type: 'Organization' } },
      { id: 222, account: { id: 22200, login: 'acme', type: 'Organization' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(getAuthenticatedGitHubUser).toHaveBeenCalledWith('github-user-token', {
      flow: 'sync',
      userId: 'user-1',
    });
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
    expect(insertedPerUserRows()).toHaveLength(0);
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.deferred_org_installations', {
      userId: 'user-1',
      deferredInstallationCount: 2,
      reason: 'shared_org_discovery_required',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
    ]);
  });

  it('does not direct-sync another user personal installation returned by GitHub user-context access', async () => {
    whereResponses.push(
      [existingInstallationRow()]
    );
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 108667778, account: { id: 910895, login: 'raphaeltm', type: 'User' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.skipped_direct_installations', {
      userId: 'user-1',
      skippedInstallationCount: 1,
      reason: 'not_authenticated_user_personal_installation',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '111' }),
    ]);
  });

  it('does not direct-sync another user personal installation when GitHub omits account id', async () => {
    whereResponses.push([existingInstallationRow()]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 108667778, account: { login: 'raphaeltm', type: 'User' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedRows).toHaveLength(0);
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.skipped_direct_installations', {
      userId: 'user-1',
      skippedInstallationCount: 1,
      reason: 'not_authenticated_user_personal_installation',
    });
  });

  it('removes a legacy mismatched personal installation row before returning installations', async () => {
    const badRow = {
      id: '01KTEWYMY2QASTZRD78XD3B673',
      userId: 'user-1',
      installationId: 'user-1:108667778',
      externalInstallationId: '108667778',
      accountType: 'personal',
      accountName: 'raphaeltm',
      createdAt: '2026-06-06T16:41:10.502Z',
      updatedAt: '2026-06-06T16:41:10.502Z',
    };
    whereResponses.push([badRow]);
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 108667778, account: { id: 910895, login: 'raphaeltm', type: 'User' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(deletedTables).toEqual([schema.githubInstallations]);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.installations_sync.removed_mismatched_personal_installation',
      {
        userId: 'user-1',
        installationId: '108667778',
        accountName: 'raphaeltm',
      }
    );
  });

  it('syncs the authenticated user personal installation from user-context GitHub access', async () => {
    whereResponses.push(
      [],
      [
        {
          id: 'inst-row-lionello',
          userId: 'user-1',
          installationId: 'user-1:113789898',
          externalInstallationId: '113789898',
          accountType: 'personal',
          accountName: 'lionello',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ]
    );
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 113789898, account: { id: 591860, login: 'lionello', type: 'User' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedCanonicalRows()).toEqual([
      expect.objectContaining({
        installationId: '113789898',
        accountType: 'personal',
        accountName: 'lionello',
        accountNameNormalized: 'lionello',
      }),
    ]);
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      installationId: 'user-1:113789898',
      externalInstallationId: '113789898',
      accountType: 'personal',
      accountName: 'lionello',
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.token_status', {
      userId: 'user-1',
      tokenPresent: true,
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.accessible_installations', {
      userId: 'user-1',
      installationCount: 1,
      installations: [
        { installationId: '113789898', accountName: 'lionello', accountType: 'User' },
      ],
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.missing_installations', {
      userId: 'user-1',
      missingInstallationCount: 1,
      installations: [{ installationId: '113789898', accountName: 'lionello', accountType: 'User' }],
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.installations_sync.insert_result', {
      userId: 'user-1',
      installationId: '113789898',
      result: 'success',
      accountName: 'lionello',
      accountType: 'User',
    });
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({ installationId: '113789898', accountName: 'lionello' }),
    ]);
  });

  it('direct-syncs authenticated user personal installation by case-insensitive login when GitHub omits account id', async () => {
    whereResponses.push(
      [],
      [
        {
          id: 'inst-row-lionello',
          userId: 'user-1',
          installationId: 'user-1:113789898',
          externalInstallationId: '113789898',
          accountType: 'personal',
          accountName: 'lionello',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
        },
      ]
    );
    mocks.getAuthenticatedGitHubUser.mockResolvedValue({ id: 591860, login: 'Lionello' });
    mocks.getUserAccessibleInstallations.mockResolvedValue([
      { id: 113789898, account: { login: 'lionello', type: 'User' } },
    ]);

    const res = await app.request('/api/github/installations', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(insertedPerUserRows()).toHaveLength(1);
    expect(insertedPerUserRows()[0]).toMatchObject({
      userId: 'user-1',
      externalInstallationId: '113789898',
      accountType: 'personal',
      accountName: 'lionello',
    });
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

  it('lists repositories through GitHub user-context installation access', async () => {
    whereResponses.push([{
      ...existingInstallationRow(),
      id: 'inst-row-111',
      externalInstallationId: '111',
      accountName: 'acme',
    }]);
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 42, fullName: 'acme/allowed-private', private: true, defaultBranch: 'main' },
    ]);

    const res = await app.request('/api/github/repositories?installation_id=inst-row-111', {}, mockEnv);

    expect(res.status).toBe(200);
    expect(getUserInstallationRepositories).toHaveBeenCalledWith('github-user-token', '111', {
      flow: 'repositories',
      userId: 'user-1',
      installationId: 'inst-row-111',
    });
    await expect(res.json()).resolves.toEqual({
      repositories: [{
        id: 42,
        fullName: 'acme/allowed-private',
        name: 'allowed-private',
        private: true,
        defaultBranch: 'main',
        installationId: 'inst-row-111',
      }],
    });
  });

  it('does not expose repos from a bad stored RaphaelTM personal installation row', async () => {
    whereResponses.push([{
      id: '01KTEWYMY2QASTZRD78XD3B673',
      userId: 'user-1',
      installationId: 'user-1:108667778',
      externalInstallationId: '108667778',
      accountType: 'personal',
      accountName: 'raphaeltm',
      createdAt: '2026-06-06T16:41:10.502Z',
      updatedAt: '2026-06-06T16:41:10.502Z',
    }]);
    mocks.getUserInstallationRepositories.mockRejectedValue(new Error('Resource not accessible'));

    const res = await app.request(
      '/api/github/repositories?installation_id=01KTEWYMY2QASTZRD78XD3B673',
      {},
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(getUserInstallationRepositories).toHaveBeenCalledWith('github-user-token', '108667778', {
      flow: 'repositories',
      userId: 'user-1',
      installationId: '01KTEWYMY2QASTZRD78XD3B673',
    });
    await expect(res.json()).resolves.toEqual({
      repositories: [],
      failedInstallations: ['raphaeltm'],
    });
    expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain('github-user-token');
  });

  it('requires user-context repository access before listing branches with an app token', async () => {
    whereResponses.push([{
      ...existingInstallationRow(),
      id: 'inst-row-111',
      externalInstallationId: '111',
      accountName: 'acme',
    }]);
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 42, fullName: 'acme/allowed-private', private: true, defaultBranch: 'main' },
    ]);
    vi.mocked(getRepositoryBranches).mockResolvedValue([{ name: 'main' }]);

    const res = await app.request(
      '/api/github/branches?installation_id=inst-row-111&repository=acme/allowed-private',
      {},
      mockEnv
    );

    expect(res.status).toBe(200);
    expect(getUserInstallationRepositories).toHaveBeenCalledWith('github-user-token', '111', {
      flow: 'branches',
      userId: 'user-1',
      installationId: 'inst-row-111',
      repository: 'acme/allowed-private',
    });
    expect(getRepositoryBranches).toHaveBeenCalledWith('111', 'acme', 'allowed-private', mockEnv, undefined);
    await expect(res.json()).resolves.toEqual([{ name: 'main' }]);
  });

  it('does not list branches for repos outside the authenticated GitHub user context', async () => {
    whereResponses.push([{
      ...existingInstallationRow(),
      id: 'inst-row-111',
      externalInstallationId: '111',
      accountName: 'acme',
    }]);
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 42, fullName: 'acme/allowed-private', private: true, defaultBranch: 'main' },
    ]);

    const res = await app.request(
      '/api/github/branches?installation_id=inst-row-111&repository=acme/forbidden-private',
      {},
      mockEnv
    );

    expect(res.status).toBe(403);
    expect(getRepositoryBranches).not.toHaveBeenCalled();
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

    const res = await postInstallationWebhook(payload);

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

  it('does NOT insert a per-user row when a personal installation account does not match the sender (webhook owner guard)', async () => {
    // User lookup by sender.id returns a SAM user, but the installation's account
    // identity (910895) does not match the installing sender (591860). This is the
    // residual-leak scenario the guard exists to prevent.
    limitResponses.push([{ id: 'user-1' }]);
    const payload = JSON.stringify({
      action: 'created',
      installation: {
        id: 555000111,
        account: { id: 910895, login: 'raphaeltm', type: 'User' },
      },
      sender: { id: 591860, login: 'lionello' },
    });

    const res = await postInstallationWebhook(payload);

    expect(res.status).toBe(200);
    // Canonical state is still recorded unconditionally.
    expect(insertedCanonicalRows()).toEqual([
      expect.objectContaining({
        installationId: '555000111',
        accountType: 'personal',
        accountName: 'raphaeltm',
      }),
    ]);
    // The leaked per-user row must NOT be created.
    expect(insertedPerUserRows()).toHaveLength(0);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.webhook.personal_installation_owner_mismatch',
      expect.objectContaining({
        installationId: '555000111',
        senderId: '591860',
        accountId: '910895',
        accountLogin: 'raphaeltm',
      })
    );
  });

  it('inserts a per-user row when a personal installation account matches the sender (webhook owner guard)', async () => {
    limitResponses.push([{ id: 'user-1' }]);
    const payload = JSON.stringify({
      action: 'created',
      installation: {
        id: 555000222,
        account: { id: 591860, login: 'lionello', type: 'User' },
      },
      sender: { id: 591860, login: 'lionello' },
    });

    const res = await postInstallationWebhook(payload);

    expect(res.status).toBe(200);
    expect(insertedPerUserRows()).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        externalInstallationId: '555000222',
        accountType: 'personal',
        accountName: 'lionello',
      }),
    ]);
  });

  it('inserts a per-user row for an org installation regardless of sender identity (webhook owner guard exempts orgs)', async () => {
    limitResponses.push([{ id: 'user-1' }]);
    const payload = JSON.stringify({
      action: 'created',
      installation: {
        id: 555000333,
        account: { id: 12345, login: 'acme', type: 'Organization' },
      },
      sender: { id: 591860, login: 'lionello' },
    });

    const res = await postInstallationWebhook(payload);

    expect(res.status).toBe(200);
    expect(insertedPerUserRows()).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        externalInstallationId: '555000333',
        accountType: 'organization',
        accountName: 'acme',
      }),
    ]);
    expect(mocks.log.warn).not.toHaveBeenCalledWith(
      'github.webhook.personal_installation_owner_mismatch',
      expect.anything()
    );
  });

  it('tombstones canonical state and removes per-user links on GitHub uninstall webhook', async () => {
    const payload = JSON.stringify({
      action: 'deleted',
      installation: {
        id: 120081765,
        account: { login: 'effprop', type: 'Organization' },
      },
    });

    const res = await postInstallationWebhook(payload);

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
      installationId: '113789898',
      result: 'conflict',
      accountName: 'lionello',
      accountType: 'User',
      error: 'UNIQUE constraint failed: github_installations.user_id, installation_id',
    });
  });

  it('logs sync insert errors without blocking the installations response', async () => {
    mockSyncInsertFailure(new Error('D1 write unavailable'));

    const res = await app.request('/api/github/installations', {}, mockEnv);

    await expectOnlyExistingInstallation(res);
    expect(mocks.log.error).toHaveBeenCalledWith('github.installations_sync.insert_result', {
      userId: 'user-1',
      installationId: '113789898',
      result: 'error',
      accountName: 'lionello',
      accountType: 'User',
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
