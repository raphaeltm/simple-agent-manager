import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock jose — generateAppJWT uses SignJWT and importPKCS8
vi.mock('jose', () => {
  const mockInstance = {
    setProtectedHeader() { return this; },
    setIssuedAt() { return this; },
    setIssuer() { return this; },
    setExpirationTime() { return this; },
    sign: vi.fn().mockResolvedValue('fake-jwt'),
  };
  return {
    SignJWT: vi.fn(() => mockInstance),
    importPKCS8: vi.fn().mockResolvedValue('fake-key'),
  };
});

import { branchExistsOnRemote } from '../../../src/services/github-app';

describe('branchExistsOnRemote', () => {
  const mockEnv = {
    GITHUB_APP_ID: 'app-123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
  } as Parameters<typeof branchExistsOnRemote>[3];

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Mock fetch to handle:
   * 1. getInstallationToken call (POST to /app/installations/.../access_tokens)
   * 2. branchExistsOnRemote call (GET to /repos/.../branches/...)
   */
  function mockFetchForBranchCheck(branchResponse: { ok: boolean; status: number; body?: unknown }) {
    const fn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      // Installation token request
      if (typeof url === 'string' && url.includes('/access_tokens')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: 'install-token', expires_at: '2099-01-01T00:00:00Z' }),
        };
      }
      // Branch check request
      return {
        ok: branchResponse.ok,
        status: branchResponse.status,
        json: async () => branchResponse.body ?? {},
      };
    });
    globalThis.fetch = fn;
    return fn;
  }

  it('returns true when the branch exists (200)', async () => {
    const fetchFn = mockFetchForBranchCheck({ ok: true, status: 200, body: { name: 'main' } });

    const result = await branchExistsOnRemote('inst-1', 'owner/repo', 'main', mockEnv);
    expect(result).toBe(true);

    // Find the branch check call (not the token call)
    const branchCall = fetchFn.mock.calls.find(
      (c: [string, ...unknown[]]) => typeof c[0] === 'string' && c[0].includes('/branches/'),
    );
    expect(branchCall).toBeDefined();
    expect(branchCall![0]).toContain('/repos/owner/repo/branches/main');
  });

  it('returns false when the branch does not exist (404)', async () => {
    mockFetchForBranchCheck({ ok: false, status: 404, body: { message: 'Branch not found' } });

    const result = await branchExistsOnRemote('inst-1', 'owner/repo', 'nonexistent', mockEnv);
    expect(result).toBe(false);
  });

  it('throws on unexpected HTTP errors (e.g., 403 rate limit)', async () => {
    mockFetchForBranchCheck({ ok: false, status: 403, body: { message: 'API rate limit exceeded' } });

    await expect(
      branchExistsOnRemote('inst-1', 'owner/repo', 'some-branch', mockEnv),
    ).rejects.toThrow(/Failed to check branch.*403/);
  });

  it('URL-encodes branch names with slashes', async () => {
    const fetchFn = mockFetchForBranchCheck({ ok: true, status: 200, body: { name: 'feature/my-branch' } });

    await branchExistsOnRemote('inst-1', 'owner/repo', 'feature/my-branch', mockEnv);

    const branchCall = fetchFn.mock.calls.find(
      (c: [string, ...unknown[]]) => typeof c[0] === 'string' && c[0].includes('/branches/'),
    );
    expect(branchCall![0]).toContain(encodeURIComponent('feature/my-branch'));
  });
});
