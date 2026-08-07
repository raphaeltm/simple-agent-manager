import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertRepositoryAccess,
  isValidRepositoryFormat,
  normalizeRepository,
} from '../../../src/routes/projects/_helpers';
import { getUserInstallationRepositories } from '../../../src/services/github-app';

const mocks = vi.hoisted(() => ({
  getUserInstallationRepositories: vi.fn(),
}));

vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));

describe('normalizeRepository', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeRepository('  Acme/Shared-Lib  ')).toBe('acme/shared-lib');
  });
});

describe('isValidRepositoryFormat', () => {
  it.each(['acme/repo', 'octocat/Hello-World', 'a/b'])(
    'accepts well-formed owner/repo: %s',
    (value) => {
      expect(isValidRepositoryFormat(value)).toBe(true);
    }
  );

  it.each([
    'no-slash',
    'too/many/segments',
    'owner/',
    '/repo',
    'owner repo',
    'owner /repo',
    '',
  ])('rejects malformed repository: %s', (value) => {
    expect(isValidRepositoryFormat(value)).toBe(false);
  });
});

describe('assertRepositoryAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('authorizes repositories visible to the authenticated GitHub user for the installation', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 1, nodeId: 'MDEwOlJlcG8x', fullName: 'acme/private-repo', private: true, defaultBranch: 'main' },
    ]);

    await expect(
      assertRepositoryAccess('github-user-token', '120081765', 'acme/private-repo', 'user-1')
    ).resolves.toEqual({
      id: 1,
      nodeId: 'MDEwOlJlcG8x',
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

  it('matches case-insensitively against the user-visible repository set', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 7, nodeId: null, fullName: 'Acme/Shared-Lib', private: true, defaultBranch: 'main' },
    ]);

    await expect(
      assertRepositoryAccess('github-user-token', '120081765', 'acme/shared-lib', 'user-1')
    ).resolves.toMatchObject({ id: 7, fullName: 'Acme/Shared-Lib' });
  });

  it('forwards a non-default flow to the GitHub lookup', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 1, nodeId: null, fullName: 'acme/repo', private: false, defaultBranch: 'main' },
    ]);

    await assertRepositoryAccess('github-user-token', '120081765', 'acme/repo', 'user-1', 'branches');

    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      expect.objectContaining({ flow: 'branches' })
    );
  });

  it('rejects repositories not visible to the authenticated GitHub user', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 1, nodeId: null, fullName: 'acme/allowed-repo', private: true, defaultBranch: 'main' },
    ]);

    await expect(
      assertRepositoryAccess('github-user-token', '120081765', 'acme/forbidden-repo', 'user-1')
    ).rejects.toThrow('Repository is not accessible through the selected installation');
  });

  it('rejects when the user has no accessible repositories for the installation', async () => {
    mocks.getUserInstallationRepositories.mockResolvedValue([]);

    await expect(
      assertRepositoryAccess('github-user-token', '120081765', 'acme/repo', 'user-1')
    ).rejects.toThrow('Repository is not accessible through the selected installation');
  });
});
