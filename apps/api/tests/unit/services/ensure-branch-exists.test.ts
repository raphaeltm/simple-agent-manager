import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger
const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Logger and runtime validation live in worker-core, which the moved GitHub App code imports.
// Runtime validation is stubbed to avoid valibot schema issues during getInstallationToken.
vi.mock('@simple-agent-manager/worker-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/worker-core')>()),
  log: mocks.log,
  readResponseJson: vi.fn().mockImplementation(async (response: Response) => {
    return response.json();
  }),
  expectJsonRecord: vi.fn().mockImplementation((val: unknown) => val),
}));

// Mock jose to avoid crypto operations when getInstallationToken is called
vi.mock('jose', () => {
  class MockSignJWT {
    setProtectedHeader() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign() {
      return 'mock-jwt';
    }
  }
  return {
    importPKCS8: vi.fn().mockResolvedValue('mock-key'),
    SignJWT: MockSignJWT,
  };
});

import type { Env } from '../../../src/env';
import { ensureBranchExists } from '../../../src/services/github-app';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
let fixture: ReturnType<typeof createAdminSettingsEnv>;
let mockEnv: Env;

describe('ensureBranchExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture = createAdminSettingsEnv({
      GITHUB_APP_ID: 'test-app-id',
      GITHUB_APP_PRIVATE_KEY: btoa('test-private-key'),
    });
    mockEnv = fixture.env;
  });

  afterEach(() => fixture.sqlite.close());

  function setupFetch(...responses: Response[]) {
    const fetchMock = vi.fn();
    // First call is always getInstallationToken's internal fetch
    fetchMock.mockResolvedValueOnce(
      Response.json({ token: 'test-installation-token', expires_at: '2026-12-31T00:00:00Z' })
    );
    for (const resp of responses) {
      fetchMock.mockResolvedValueOnce(resp);
    }
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reports exists immediately when the branch is already on the remote', async () => {
    const fetchMock = setupFetch(Response.json({ name: 'feature-branch' }));

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({ status: 'exists' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/owner/repo/branches/feature-branch',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-installation-token',
        }),
      })
    );
  });

  it('uses the provided external GitHub installation id when minting the token', async () => {
    const fetchMock = setupFetch(Response.json({ name: 'feature-branch' }));

    const result = await ensureBranchExists(
      '987654321',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({ status: 'exists' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/app/installations/987654321/access_tokens',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('01KTDBROW000000000000000001'),
      expect.anything()
    );
  });

  it('creates branch from default branch when it does not exist', async () => {
    const fetchMock = setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: { sha: 'abc123def456' } }),
      Response.json(
        { ref: 'refs/heads/feature-branch', object: { sha: 'abc123def456' } },
        { status: 201 }
      )
    );

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({ status: 'created' });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/owner/repo/git/ref/heads/main',
      expect.any(Object)
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://api.github.com/repos/owner/repo/git/refs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ref: 'refs/heads/feature-branch', sha: 'abc123def456' }),
      })
    );

    expect(mocks.log.info).toHaveBeenCalledWith('github.ensure_branch.created', {
      owner: 'owner',
      repo: 'repo',
      branchName: 'feature-branch',
      fromBranch: 'main',
      sha: 'abc123def456',
    });
  });

  it('handles race condition (422 from create) gracefully', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: { sha: 'abc123' } }),
      new Response(null, { status: 422 })
    );

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({ status: 'exists' });
  });

  it('reports missing when the base branch ref lookup fails (branch confirmed absent)', async () => {
    setupFetch(new Response(null, { status: 404 }), new Response(null, { status: 404 }));

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({
      status: 'missing',
      reason: 'base branch "main" could not be resolved (404)',
    });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.default_branch_ref_failed',
      expect.objectContaining({ status: 404 })
    );
  });

  it('reports missing when branch creation fails with a non-422 error', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: { sha: 'abc123' } }),
      new Response(null, { status: 403 })
    );

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({ status: 'missing', reason: 'branch creation failed (403)' });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.create_failed',
      expect.objectContaining({ status: 403 })
    );
  });

  it('reports unknown when the branch check itself fails (nothing learned about the ref)', async () => {
    const fetchMock = setupFetch(new Response(null, { status: 500 }));

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({ status: 'unknown', reason: 'branch lookup returned 500' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.check_failed',
      expect.objectContaining({ status: 500 })
    );
  });

  it('reports missing when the base branch ref has no commit SHA', async () => {
    setupFetch(
      new Response(null, { status: 404 }),
      Response.json({ ref: 'refs/heads/main', object: {} })
    );

    const result = await ensureBranchExists(
      'inst-123',
      'owner',
      'repo',
      'feature-branch',
      'main',
      mockEnv
    );

    expect(result).toEqual({
      status: 'missing',
      reason: 'base branch "main" returned no commit SHA',
    });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'github.ensure_branch.no_sha',
      expect.objectContaining({ owner: 'owner', repo: 'repo' })
    );
  });
});
