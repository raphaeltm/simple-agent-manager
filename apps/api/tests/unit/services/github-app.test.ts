import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUserAccessibleInstallations } from '../../../src/services/github-app';

describe('getUserAccessibleInstallations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

    const result = await getUserAccessibleInstallations('github-user-token');

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
  });

  it('throws the GitHub error message when listing accessible installations fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ message: 'Bad credentials' }, { status: 401 }))
    );

    await expect(getUserAccessibleInstallations('expired-token')).rejects.toThrow('Bad credentials');
  });
});
