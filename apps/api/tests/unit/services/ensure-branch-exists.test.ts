import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger
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

// Mock jose to avoid crypto operations when getInstallationToken is called
vi.mock('jose', () => {
  class MockSignJWT {
    setProtectedHeader() { return this; }
    setIssuedAt() { return this; }
    setIssuer() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'mock-jwt'; }
  }
  return {
    importPKCS8: vi.fn().mockResolvedValue('mock-key'),
    SignJWT: MockSignJWT,
  };
});

// Mock runtime-validation to avoid valibot schema issues during getInstallationToken
vi.mock('../../../src/lib/runtime-validation', () => ({
  readResponseJson: vi.fn().mockImplementation(async (response: Response) => {
    return response.json();
  }),
  expectJsonRecord: vi.fn().mockImplementation((val: unknown) => val),
}));

import { ensureBranchExists } from '../../../src/services/github-app';
import type { Env } from '../../../src/env';

const mockEnv = {
  GITHUB_APP_ID: 'test-app-id',
  GITHUB_APP_PRIVATE_KEY: btoa('test-private-key'),
} as unknown as Env;

describe('ensureBranchExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupFetch(...responses: Response[]) {
    const fetchMock = vi.fn();
    // First call is always getInstallationToken's internal fetch
    fetchMock.mockResolvedValueOnce(
      Response.json({ token: 'test-installation-token', expires_at: '2026-12-31T00:00:00Z' }),
    );
    for (const resp of responses) {
      fetchMock.mockResolvedValueOnce(resp);
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('returns true immediately when branch already exists', async () => {
    const fetchMock = setupFetch(
      Response.json({ name: 'feature-branch' }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'https://api.github.com/repos/owner/repo/branches/feature-branch',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-installation-token',
        }),
      }),
    );
  });

  it('creates branch from default branch when it does not exist', async () => {
    const fetchMock = setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: { sha: 'abc123def456' } }),
      Response.json({ ref: 'refs/heads/feature-branch', object: { sha: 'abc123def456' } }, { status: 201 }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(fetchMock).toHaveBeenNthCalledWith(3,
      'https://api.github.com/repos/owner/repo/git/ref/heads/main',
      expect.any(Object),
    );

    expect(fetchMock).toHaveBeenNthCalledWith(4,
      'https://api.github.com/repos/owner/repo/git/refs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/feature-branch', sha: 'abc123def456' }),
      }),
    );

    expect(mocks.log.info).toHaveBeenCalledWith('github.ensure_branch.created', {
      owner: 'owner', repo: 'repo', branchName: 'feature-branch',
      fromBranch: 'main', sha: 'abc123def456',
    });
  });

  it('handles race condition (422 from create) gracefully', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: { sha: 'abc123' } }),
      new Response(null, { status: 422 }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(true);
  });

  it('returns false when default branch ref lookup fails', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.default_branch_ref_failed',
      expect.objectContaining({ status: 404 }),
    );
  });

  it('returns false when branch creation fails with non-422 error', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: { sha: 'abc123' } }),
      new Response(null, { status: 403 }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.create_failed',
      expect.objectContaining({ status: 403 }),
    );
  });

  it('returns false when branch check returns unexpected error', async () => {
    const fetchMock = setupFetch(
      new Response(null, { status: 500 }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.check_failed',
      expect.objectContaining({ status: 500 }),
    );
  });

  it('returns false when ref data has no SHA', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: {} }),
    );

    const result = await ensureBranchExists(
      'inst-123', 'owner', 'repo', 'feature-branch', 'main', mockEnv,
    );

    expect(result).toBe(false);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.no_sha',
      expect.objectContaining({ owner: 'owner', repo: 'repo' }),
    );
  });
});
