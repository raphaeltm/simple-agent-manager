import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertRepositoryAccess } from '../../../src/routes/projects/_helpers';
import { getUserInstallationRepositories } from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  getUserInstallationRepositories: vi.fn(),
}));

vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));

describe('assertRepositoryAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authorizes repositories visible to the authenticated GitHub user for the installation', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 1, fullName: 'acme/private-repo', private: true, defaultBranch: 'main' },
    ]);

    await expect(
      assertRepositoryAccess('github-user-token', '120081765', 'acme/private-repo', 'user-1')
    ).resolves.toEqual({
      id: 1,
      fullName: 'acme/private-repo',
      private: true,
      defaultBranch: 'main',
    });

    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      {
        flow: 'project-access',
        userId: 'user-1',
        installationId: '120081765',
        repository: 'acme/private-repo',
      }
    );
  });

  it('rejects repositories not visible to the authenticated GitHub user', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 1, fullName: 'acme/allowed-repo', private: true, defaultBranch: 'main' },
    ]);

    await expect(
      assertRepositoryAccess('github-user-token', '120081765', 'acme/forbidden-repo', 'user-1')
    ).rejects.toThrow('Repository is not accessible through the selected installation');
  });
});
