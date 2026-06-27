import { describe, expect, it } from 'vitest';

import {
  deriveProjectName,
  isCredentialError,
  isNotApprovedError,
  mapProjectCreateError,
  normalizeRepository,
  profilePayload,
} from '../../../src/components/project-onboarding/shared';

// shared.tsx imports ApiClientError from ../../lib/api, which re-exports from ./client.
// In vitest's jsdom environment the barrel and direct imports may produce different class
// identities due to module resolution. We import from the same barrel path that shared.tsx
// uses so that instanceof checks in the helpers match.
async function makeApiError(message: string, status: number): Promise<Error> {
  const mod = await import('../../../src/lib/api');
  // ApiClientError constructor is (code, message, status)
  return new mod.ApiClientError('ERROR', message, status);
}

describe('normalizeRepository', () => {
  it('strips HTTPS GitHub URL prefix', () => {
    expect(normalizeRepository('https://github.com/org/repo.git')).toBe('org/repo');
  });

  it('strips SSH GitHub URL prefix', () => {
    expect(normalizeRepository('git@github.com:org/repo.git')).toBe('org/repo');
  });

  it('passes through owner/repo format', () => {
    expect(normalizeRepository('org/repo')).toBe('org/repo');
  });

  it('lowercases the result', () => {
    expect(normalizeRepository('ORG/Repo')).toBe('org/repo');
  });
});

describe('deriveProjectName', () => {
  it('extracts repo name from owner/repo', () => {
    expect(deriveProjectName('org/my-repo')).toBe('my-repo');
  });

  it('handles full GitHub URL', () => {
    expect(deriveProjectName('https://github.com/org/my-repo.git')).toBe('my-repo');
  });
});

describe('mapProjectCreateError', () => {
  it('maps 409 with "Project name" to name field', async () => {
    const err = await makeApiError('Project name conflict', 409);
    expect(mapProjectCreateError(err)).toEqual({
      name: 'A project with this name already exists.',
    });
  });

  it('maps 409 with "repository ID" to githubRepoId field', async () => {
    const err = await makeApiError('repository ID conflict', 409);
    expect(mapProjectCreateError(err)).toEqual({
      githubRepoId: 'This GitHub repository is already linked to another project.',
    });
  });

  it('maps 409 with "repository" to repository field', async () => {
    const err = await makeApiError('repository conflict', 409);
    expect(mapProjectCreateError(err)).toEqual({
      repository: 'This repository is already linked to another project.',
    });
  });

  it('maps non-409 errors to general', () => {
    expect(mapProjectCreateError(new Error('Server error'))).toEqual({
      general: 'Server error',
    });
  });
});

describe('isNotApprovedError', () => {
  it('returns true for 403 with "approved" in message', async () => {
    const err = await makeApiError('Account not approved', 403);
    expect(isNotApprovedError(err)).toBe(true);
  });

  it('returns true for 403 with "pending" in message', async () => {
    const err = await makeApiError('Account pending', 403);
    expect(isNotApprovedError(err)).toBe(true);
  });

  it('returns false for 403 without matching keywords', async () => {
    const err = await makeApiError('Forbidden', 403);
    expect(isNotApprovedError(err)).toBe(false);
  });

  it('returns false for non-ApiClientError', () => {
    expect(isNotApprovedError(new Error('approved'))).toBe(false);
  });
});

describe('isCredentialError', () => {
  it('returns true for ApiClientError with 403 status', async () => {
    const err = await makeApiError('Forbidden', 403);
    expect(isCredentialError(err)).toBe(true);
  });

  it('returns false for non-403 status', async () => {
    const err = await makeApiError('Not found', 404);
    expect(isCredentialError(err)).toBe(false);
  });

  it('returns false for non-ApiClientError', () => {
    expect(isCredentialError(new Error('Forbidden'))).toBe(false);
  });
});

describe('profilePayload', () => {
  const base = {
    name: 'Test Profile',
    description: 'A description',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5-20250514',
    useCustomGithubPolicy: false,
  };

  it('omits githubCliPolicy when useCustomGithubPolicy is false', () => {
    const result = profilePayload(base, 'task');
    expect(result).not.toHaveProperty('githubCliPolicy');
    expect(result.taskMode).toBe('task');
    expect(result.name).toBe('Test Profile');
  });

  it('includes githubCliPolicy when useCustomGithubPolicy is true', () => {
    const result = profilePayload({ ...base, useCustomGithubPolicy: true }, 'conversation');
    expect(result.githubCliPolicy).toBeDefined();
    expect(result.githubCliPolicy?.mode).toBe('custom');
    expect(result.githubCliPolicy?.repositoryScope).toBe('project');
    expect(result.taskMode).toBe('conversation');
  });

  it('trims name and description', () => {
    const result = profilePayload({ ...base, name: '  Trimmed  ', description: '  Desc  ' }, 'task');
    expect(result.name).toBe('Trimmed');
    expect(result.description).toBe('Desc');
  });

  it('sets model to null when empty', () => {
    const result = profilePayload({ ...base, model: '' }, 'task');
    expect(result.model).toBeNull();
  });
});
