import type { GitHubCliPolicy } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  GitHubCliPolicyError,
  resolveWorkspaceGitHubTokenOptions,
  toInstallationTokenOptions,
} from '../../../src/services/github-cli-policy';

function makePolicy(overrides: Partial<GitHubCliPolicy> = {}): GitHubCliPolicy {
  return {
    mode: 'custom',
    repositoryScope: 'project',
    permissions: {
      contents: 'write',
      pullRequests: 'write',
      issues: 'none',
      actions: 'none',
      packages: 'none',
    },
    ...overrides,
  };
}

function makeFakeDb(...queryResults: unknown[][]) {
  const rows = [...queryResults];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => rows.shift() ?? [],
          }),
          limit: () => rows.shift() ?? [],
        }),
      }),
    }),
  };
}

const DEFAULT_INPUT = {
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  userId: 'user-1',
  githubRepoId: 12345,
} as const;

describe('GitHub CLI policy token options', () => {
  it('keeps inherited profiles on the existing full-installation token path', () => {
    const policy = makePolicy({ mode: 'inherit' });
    expect(toInstallationTokenOptions(policy, 123)).toBeNull();
  });

  it('converts custom profile policy into repository-scoped GitHub permissions', () => {
    const policy = makePolicy({
      permissions: {
        contents: 'write',
        pullRequests: 'write',
        issues: 'none',
        actions: 'read',
        packages: 'none',
      },
    });

    expect(toInstallationTokenOptions(policy, 987654)).toEqual({
      repositoryIds: [987654],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        actions: 'read',
      },
    });
  });

  it('fails closed when project-scoped custom policy cannot resolve a GitHub repo id', () => {
    const policy = makePolicy({
      permissions: {
        contents: 'read',
        pullRequests: 'none',
        issues: 'read',
        actions: 'none',
        packages: 'write',
      },
    });

    expect(() => toInstallationTokenOptions(policy, null)).toThrow(GitHubCliPolicyError);
  });

  it('resolves task-linked profile policy into token options for a workspace', async () => {
    const policy = makePolicy({
      permissions: {
        contents: 'read',
        pullRequests: 'write',
        issues: 'none',
        actions: 'none',
        packages: 'none',
      },
    });
    const db = makeFakeDb(
      [{ profileId: 'profile-release' }],
      [{ githubCliPolicy: JSON.stringify(policy) }]
    );

    await expect(
      resolveWorkspaceGitHubTokenOptions(db as never, DEFAULT_INPUT)
    ).resolves.toEqual({
      repositoryIds: [12345],
      permissions: {
        contents: 'read',
        pull_requests: 'write',
      },
    });
  });

  it('fails closed when a task-linked profile stores invalid policy JSON', async () => {
    const db = makeFakeDb(
      [{ profileId: 'profile-release' }],
      [{ githubCliPolicy: '{invalid' }]
    );

    await expect(
      resolveWorkspaceGitHubTokenOptions(db as never, DEFAULT_INPUT)
    ).rejects.toThrow(GitHubCliPolicyError);
  });
});
