import { afterEach, expect, it, vi } from 'vitest';

import {
  getUserInstallationRepositories,
  GITHUB_REPOSITORY_MAX_PAGE,
  GITHUB_REPOSITORY_PAGE_SIZE,
  GITHUB_REPOSITORY_SCAN_LIMIT,
} from '../../../src/services/github-app';

afterEach(() => vi.unstubAllGlobals());

it('derives the hint range from the same scan and page bounds and rejects a hint outside it', async () => {
  expect(GITHUB_REPOSITORY_MAX_PAGE).toBe(
    Math.ceil(GITHUB_REPOSITORY_SCAN_LIMIT / GITHUB_REPOSITORY_PAGE_SIZE)
  );
  const fetchMock = vi.fn(async () =>
    Response.json({
      total_count: 1,
      repositories: [{ id: 4, full_name: 'acme/target', private: true, default_branch: 'main' }],
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  await getUserInstallationRepositories(
    'current',
    '123',
    { flow: 'project-access', userId: 'u', installationId: '123' },
    { repository: 'acme/target', pageHint: GITHUB_REPOSITORY_MAX_PAGE + 1 }
  );
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('page=1'), expect.anything());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
