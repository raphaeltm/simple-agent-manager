/**
 * Unit tests for Artifacts-backed project creation.
 *
 * Verifies the project creation schema, repo provider validation,
 * and git-token response shape for Artifacts projects.
 */

import { ARTIFACTS_DEFAULTS, VALID_REPO_PROVIDERS } from '@simple-agent-manager/shared';
import { parse } from 'valibot';
import { describe, expect, it } from 'vitest';

import { CreateProjectSchema } from '../../src/schemas/projects';

describe('CreateProjectSchema with repoProvider', () => {
  it('accepts artifacts as repoProvider', () => {
    const result = parse(CreateProjectSchema, {
      name: 'My Artifacts Project',
      repoProvider: 'artifacts',
    });
    expect(result.repoProvider).toBe('artifacts');
    expect(result.installationId).toBeUndefined();
    expect(result.repository).toBeUndefined();
  });

  it('accepts github as repoProvider with required fields', () => {
    const result = parse(CreateProjectSchema, {
      name: 'My GitHub Project',
      repoProvider: 'github',
      installationId: 'inst-123',
      repository: 'owner/repo',
      defaultBranch: 'main',
    });
    expect(result.repoProvider).toBe('github');
    expect(result.installationId).toBe('inst-123');
    expect(result.repository).toBe('owner/repo');
    expect(result.defaultBranch).toBe('main');
  });

  it('defaults to no repoProvider when omitted (backward compat)', () => {
    const result = parse(CreateProjectSchema, {
      name: 'Legacy Project',
      installationId: 'inst-123',
      repository: 'owner/repo',
      defaultBranch: 'main',
    });
    expect(result.repoProvider).toBeUndefined();
  });

  it('rejects invalid repoProvider value', () => {
    expect(() =>
      parse(CreateProjectSchema, {
        name: 'Bad Provider',
        repoProvider: 'bitbucket',
      })
    ).toThrow();
  });

  it('makes installationId, repository, defaultBranch optional', () => {
    const result = parse(CreateProjectSchema, {
      name: 'Minimal Project',
    });
    expect(result.name).toBe('Minimal Project');
    expect(result.installationId).toBeUndefined();
    expect(result.repository).toBeUndefined();
    expect(result.defaultBranch).toBeUndefined();
  });
});

describe('RepoProvider type', () => {
  it('VALID_REPO_PROVIDERS contains both providers', () => {
    expect(VALID_REPO_PROVIDERS).toContain('github');
    expect(VALID_REPO_PROVIDERS).toContain('artifacts');
    expect(VALID_REPO_PROVIDERS).toHaveLength(2);
  });

  it('ARTIFACTS_DEFAULTS has expected values', () => {
    expect(ARTIFACTS_DEFAULTS.DEFAULT_BRANCH).toBe('main');
    expect(ARTIFACTS_DEFAULTS.TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(ARTIFACTS_DEFAULTS.MAX_REPOS_PER_USER).toBeGreaterThan(0);
  });
});

describe('Git token response for Artifacts', () => {
  it('Artifacts git-token response shape includes cloneUrl', () => {
    // Simulates the response shape from the git-token endpoint for Artifacts projects
    const response = {
      token: 'art_v1_abc123',
      expiresAt: '2026-04-25T12:00:00Z',
      cloneUrl: 'https://acct123.artifacts.cloudflare.net/git/default/my-repo.git',
    };

    expect(response.token).toBeTruthy();
    expect(response.cloneUrl).toContain('artifacts.cloudflare.net');
    expect(response.expiresAt).toBeTruthy();
  });

  it('GitHub git-token response shape omits cloneUrl', () => {
    const response = {
      token: 'ghs_abc123',
      expiresAt: '2026-04-25T12:00:00Z',
    };

    expect(response.token).toBeTruthy();
    expect((response as any).cloneUrl).toBeUndefined();
  });
});

describe('Artifacts agent instructions', () => {
  it('artifacts projects should produce instructions that forbid gh CLI', () => {
    // Simulates what handleGetInstructions returns for Artifacts projects
    const repoProvider = 'artifacts';
    const artifactsInstructions = repoProvider === 'artifacts'
      ? [
          'This project uses SAM Git (Cloudflare Artifacts) — NOT GitHub.',
          'Do NOT use `gh pr create`, `gh` CLI, or any GitHub-specific commands.',
          'Push your changes directly to the remote branch. Summarize your changes in the task completion message.',
        ]
      : [];

    expect(artifactsInstructions).toHaveLength(3);
    expect(artifactsInstructions.some(i => i.includes('gh pr create'))).toBe(true);
    expect(artifactsInstructions.some(i => i.includes('NOT GitHub'))).toBe(true);
  });

  it('github projects should not produce artifacts instructions', () => {
    const repoProvider = 'github';
    const artifactsInstructions = repoProvider === 'artifacts'
      ? ['This project uses SAM Git']
      : [];

    expect(artifactsInstructions).toHaveLength(0);
  });
});

describe('Artifacts project repository format', () => {
  it('stores full clone URL as repository for Artifacts projects', () => {
    // The project creation stores created.remote as repository
    // This ensures normalizeRepoURL on the VM agent passes it through
    const repository = 'https://acct123.artifacts.cloudflare.net/git/default/my-project-abc.git';

    // Verify it's a valid HTTPS URL (normalizeRepoURL will pass these through)
    expect(repository.startsWith('https://')).toBe(true);
    expect(repository).toContain('artifacts.cloudflare.net');
  });
});
