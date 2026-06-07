import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { requireRepositoryUserAccess } from '../../../src/routes/projects/_helpers';
import { getUserInstallationRepositories } from '../../../src/services/github-app';
import { getGitHubUserAccessToken } from '../../../src/services/github-user-access-token';

const mocks = vi.hoisted(() => ({
  getGitHubUserAccessToken: vi.fn(),
  getUserInstallationRepositories: vi.fn(),
}));

vi.mock('../../../src/services/github-user-access-token', () => ({
  getGitHubUserAccessToken: mocks.getGitHubUserAccessToken,
}));

vi.mock('../../../src/services/github-app', () => ({
  getUserInstallationRepositories: mocks.getUserInstallationRepositories,
}));

/**
 * Build a Drizzle-shaped db stub whose `.select().from().where().limit(n)`
 * resolves the supplied installation rows. `requireOwnedInstallation` is the
 * only db consumer inside the helper, so this single chain is sufficient.
 */
function makeDb(installationRows: Array<Partial<schema.GitHubInstallation>>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(installationRows),
        }),
      }),
    }),
  } as unknown as Parameters<typeof requireRepositoryUserAccess>[1];
}

const ctx = {} as Context<{ Bindings: Env }>;

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'user-1',
    repoProvider: 'github',
    installationId: 'inst-row-111',
    repository: 'acme/allowed-private',
    githubRepoId: 42,
    ...overrides,
  } as schema.Project;
}

const INSTALLATION_ROW: Partial<schema.GitHubInstallation> = {
  id: 'inst-row-111',
  userId: 'user-1',
  externalInstallationId: '120081765',
};

const VISIBLE_REPO = {
  id: 42,
  nodeId: 'R_kgDOAllowed',
  fullName: 'acme/allowed-private',
  private: true,
  defaultBranch: 'main',
};

describe('requireRepositoryUserAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips the gate for non-github (artifacts-backed) projects', async () => {
    const project = makeProject({ repoProvider: 'artifacts', installationId: '' });

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([]), project, 'user-1')
    ).resolves.toBeUndefined();

    expect(mocks.getGitHubUserAccessToken).not.toHaveBeenCalled();
    expect(mocks.getUserInstallationRepositories).not.toHaveBeenCalled();
  });

  it('still runs the gate for a legacy project whose repoProvider is null (falsy guard does not skip)', async () => {
    // The guard skips only EXPLICIT non-github providers (`repoProvider &&
    // repoProvider !== 'github'`). A null/undefined repoProvider is a legacy
    // github-backed project and MUST still be intersected — never silently
    // skipped (that would reopen the spawn leak this gate closes).
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    await expect(
      requireRepositoryUserAccess(
        ctx,
        makeDb([INSTALLATION_ROW]),
        makeProject({ repoProvider: null as unknown as schema.Project['repoProvider'], githubRepoId: 42 }),
        'user-1'
      )
    ).resolves.toBeUndefined();

    // The intersection source WAS consulted — the gate ran, it was not skipped.
    expect(mocks.getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      expect.objectContaining({ userId: 'user-1', repository: 'acme/allowed-private' })
    );
  });

  it('fails fast with 403 when the user has no GitHub token — before any repo query', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue(null);

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([INSTALLATION_ROW]), makeProject(), 'user-1')
    ).rejects.toMatchObject({ statusCode: 403, message: 'GitHub user token unavailable' });

    // Intersection source must NOT be consulted once the token is missing.
    expect(mocks.getUserInstallationRepositories).not.toHaveBeenCalled();
  });

  it('rejects with 403 when the bound repository is no longer visible to the user', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { id: 7, nodeId: 'R_kgDOOther', fullName: 'acme/other-private', private: true, defaultBranch: 'main' },
    ]);

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([INSTALLATION_ROW]), makeProject(), 'user-1')
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'Repository is not accessible through the selected installation',
    });
  });

  it('rejects with 403 when the verified repository id has drifted from the bound githubRepoId', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    // User can see a repo with the same full name, but a DIFFERENT id —
    // the repository was deleted and recreated, or the name was re-pointed.
    mocks.getUserInstallationRepositories.mockResolvedValue([
      { ...VISIBLE_REPO, id: 999 },
    ]);

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([INSTALLATION_ROW]), makeProject({ githubRepoId: 42 }), 'user-1')
    ).rejects.toMatchObject({
      statusCode: 403,
      message: 'GitHub repository access has changed; repository ID no longer matches',
    });
  });

  it('resolves on the happy path when the user can see the bound repository and ids match', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([INSTALLATION_ROW]), makeProject({ githubRepoId: 42 }), 'user-1')
    ).resolves.toBeUndefined();

    // Intersection uses the user OAuth token + the installation's EXTERNAL id.
    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'github-user-token',
      '120081765',
      {
        flow: 'project-access',
        userId: 'user-1',
        installationId: '120081765',
        repository: 'acme/allowed-private',
      }
    );
  });

  it('skips the drift check when the project has no bound githubRepoId (legacy project)', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([{ ...VISIBLE_REPO, id: 12345 }]);

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([INSTALLATION_ROW]), makeProject({ githubRepoId: null }), 'user-1')
    ).resolves.toBeUndefined();
  });

  it('rejects with 404 when the installation is not owned by the user', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue('github-user-token');

    await expect(
      requireRepositoryUserAccess(ctx, makeDb([]), makeProject(), 'user-1')
    ).rejects.toMatchObject({ statusCode: 404, message: 'Installation not found' });

    // The repo query must not run if the installation lookup fails.
    expect(mocks.getUserInstallationRepositories).not.toHaveBeenCalled();
  });

  it('preserves org sharing: a distinct user with their own access resolves independently', async () => {
    mocks.getGitHubUserAccessToken.mockResolvedValue('user-2-token');
    mocks.getUserInstallationRepositories.mockResolvedValue([VISIBLE_REPO]);

    const sharedProject = makeProject({ userId: 'user-2', githubRepoId: 42 });

    await expect(
      requireRepositoryUserAccess(
        ctx,
        makeDb([{ ...INSTALLATION_ROW, userId: 'user-2' }]),
        sharedProject,
        'user-2'
      )
    ).resolves.toBeUndefined();

    expect(getUserInstallationRepositories).toHaveBeenCalledWith(
      'user-2-token',
      '120081765',
      expect.objectContaining({ userId: 'user-2' })
    );
    expect(getGitHubUserAccessToken).toHaveBeenCalledWith(ctx, 'user-2');
  });
});
