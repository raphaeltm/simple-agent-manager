import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAuthenticatedUserOrganizations,
  getUserAccessibleInstallations,
  verifyUserInstallationAccess,
} from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
}));

describe('getUserAccessibleInstallations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists all installations accessible to the GitHub user token across pages', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `org-${index + 1}`, type: 'Organization' },
    }));
    const secondPage = [
      { id: 101, account: { login: 'personal-user', type: 'User' } },
    ];

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ installations: firstPage }))
      .mockResolvedValueOnce(Response.json({ installations: secondPage }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUserAccessibleInstallations('github-user-token', {
      flow: 'sync',
      userId: 'user-1',
    });

    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ id: 1, account: { login: 'org-1', type: 'Organization' } });
    expect(result[100]).toEqual({ id: 101, account: { login: 'personal-user', type: 'User' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user/installations?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer github-user-token',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/installations?per_page=100&page=2',
      expect.any(Object)
    );
    expect(mocks.log.info).toHaveBeenCalledWith('github.user_accessible_installations.response', {
      flow: 'sync',
      userId: 'user-1',
      installationId: undefined,
      page: 1,
      status: 200,
      ok: true,
      installationCount: 100,
    });
    expect(mocks.log.info).toHaveBeenCalledWith('github.user_accessible_installations.response', {
      flow: 'sync',
      userId: 'user-1',
      installationId: undefined,
      page: 2,
      status: 200,
      ok: true,
      installationCount: 1,
    });
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain('github-user-token');
  });

  it('throws the GitHub error message when listing accessible installations fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ message: 'Bad credentials' }, { status: 401 }))
    );

    await expect(getUserAccessibleInstallations('expired-token', {
      flow: 'callback',
      userId: 'user-1',
      installationId: '123',
    })).rejects.toThrow('Bad credentials');
    expect(mocks.log.warn).toHaveBeenCalledWith('github.user_accessible_installations.response', {
      flow: 'callback',
      userId: 'user-1',
      installationId: '123',
      page: 1,
      status: 401,
      ok: false,
      installationCount: 0,
    });
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('expired-token');
  });
});

describe('getAuthenticatedUserOrganizations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists all organizations for the authenticated GitHub user across pages', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      login: `org-${index + 1}`,
    }));
    const secondPage = [{ login: 'effprop' }];

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(firstPage))
      .mockResolvedValueOnce(Response.json(secondPage));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAuthenticatedUserOrganizations('github-user-token', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
    });

    expect(result).toHaveLength(101);
    expect(result[0]).toEqual({ login: 'org-1' });
    expect(result[100]).toEqual({ login: 'effprop' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/user/orgs?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer github-user-token',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/orgs?per_page=100&page=2',
      expect.any(Object)
    );
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain('github-user-token');
  });

  it('throws the GitHub error message when listing organizations fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ message: 'Requires read:org' }, { status: 403 }))
    );

    await expect(getAuthenticatedUserOrganizations('expired-token', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
    })).rejects.toThrow('Requires read:org');
    expect(mocks.log.warn).toHaveBeenCalledWith('github.user_organizations.response', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      page: 1,
      status: 403,
      ok: false,
      organizationCount: 0,
    });
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('expired-token');
  });
});

describe('verifyUserInstallationAccess', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns true when GitHub confirms user access to the installation repositories endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ total_count: 1, repositories: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyUserInstallationAccess('github-user-token', '120081765', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/user/installations/120081765/repositories?per_page=1',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer github-user-token',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      })
    );
    expect(mocks.log.info).toHaveBeenCalledWith('github.user_installation_access.response', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
      status: 200,
      ok: true,
    });
  });

  it.each([403, 404])('returns false for GitHub %s responses', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ message: 'not accessible' }, { status }))
    );

    const result = await verifyUserInstallationAccess('github-user-token', '120081765', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
    });

    expect(result).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalledWith('github.user_installation_access.response', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
      status,
      ok: false,
    });
    expect(JSON.stringify(mocks.log.warn.mock.calls)).not.toContain('github-user-token');
  });

  it('throws transient GitHub verification failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ message: 'Server unavailable' }, { status: 503 }))
    );

    await expect(verifyUserInstallationAccess('github-user-token', '120081765', {
      flow: 'shared-org-discovery',
      userId: 'user-1',
      installationId: '120081765',
      accountName: 'effprop',
    })).rejects.toThrow('Server unavailable');
  });
});
