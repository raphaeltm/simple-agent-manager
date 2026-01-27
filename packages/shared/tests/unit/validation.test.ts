import { describe, it, expect } from 'vitest';
import {
  validateCreateWorkspaceRequest,
  extractRepoName,
} from '../../src/lib/validation';

describe('validateCreateWorkspaceRequest', () => {
  const validRequest = {
    name: 'my-workspace',
    repository: 'user/repo',
    installationId: 'inst_123',
  };

  it('validates a correct request', () => {
    const result = validateCreateWorkspaceRequest(validRequest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing name', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      name: undefined,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name' })
    );
  });

  it('rejects missing repository', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      repository: undefined,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'repository' })
    );
  });

  it('rejects invalid repository format', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      repository: 'not-valid-format',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'repository' })
    );
  });

  it('accepts valid repository formats', () => {
    expect(
      validateCreateWorkspaceRequest({ ...validRequest, repository: 'user/repo' }).valid
    ).toBe(true);
    expect(
      validateCreateWorkspaceRequest({ ...validRequest, repository: 'org-name/my-repo' }).valid
    ).toBe(true);
    expect(
      validateCreateWorkspaceRequest({ ...validRequest, repository: 'User123/Repo_Name' }).valid
    ).toBe(true);
  });

  it('rejects missing installationId', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      installationId: undefined,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'installationId' })
    );
  });

  it('rejects invalid vmSize', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      vmSize: 'extra-large' as 'small',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'vmSize' })
    );
  });

  it('accepts valid vmSize values', () => {
    expect(
      validateCreateWorkspaceRequest({ ...validRequest, vmSize: 'small' }).valid
    ).toBe(true);
    expect(
      validateCreateWorkspaceRequest({ ...validRequest, vmSize: 'medium' }).valid
    ).toBe(true);
    expect(
      validateCreateWorkspaceRequest({ ...validRequest, vmSize: 'large' }).valid
    ).toBe(true);
  });

  it('allows omitting optional vmSize', () => {
    const result = validateCreateWorkspaceRequest({
      name: 'test',
      repository: 'user/repo',
      installationId: 'inst_123',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects name that is too long', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      name: 'a'.repeat(51),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name' })
    );
  });

  it('rejects name with invalid characters', () => {
    const result = validateCreateWorkspaceRequest({
      ...validRequest,
      name: 'invalid name!',
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name' })
    );
  });
});

describe('extractRepoName', () => {
  it('extracts name from owner/repo format', () => {
    expect(extractRepoName('user/my-repo')).toBe('my-repo');
    expect(extractRepoName('org/project')).toBe('project');
  });

  it('handles simple repo names', () => {
    expect(extractRepoName('my-repo')).toBe('my-repo');
  });

  it('handles empty string', () => {
    expect(extractRepoName('')).toBe('workspace');
  });

  it('handles deeply nested paths', () => {
    expect(extractRepoName('a/b/c/repo')).toBe('repo');
  });
});
