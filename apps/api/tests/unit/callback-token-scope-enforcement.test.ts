/**
 * Callback Token Scope Enforcement — Behavioral Tests
 *
 * Tests the security boundary: node-scoped callback tokens MUST NOT
 * be able to access workspace-scoped endpoints (agent-key, runtime-assets, etc.)
 *
 * This is the critical test that would have caught the cross-workspace
 * secret access vulnerability where a shared node-level CALLBACK_TOKEN
 * could fetch API keys for any co-tenant workspace.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { CallbackTokenPayload } from '../../src/services/jwt';

// Mock drizzle to return workspace with nodeId
const mockDbSelect = vi.fn();
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelect(),
        }),
      }),
    }),
  }),
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn(),
  };
});

// Mock JWT verification with controllable scope
const mockVerifyCallbackToken = vi.fn<(token: string, env: unknown) => Promise<CallbackTokenPayload>>();
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: [string, unknown]) => mockVerifyCallbackToken(...args),
  signCallbackToken: vi.fn().mockResolvedValue('mock-workspace-token'),
  signNodeCallbackToken: vi.fn().mockResolvedValue('mock-node-token'),
}));

// Import after mocks
import { verifyWorkspaceCallbackAuth } from '../../src/routes/workspaces/_helpers';

function makeContext(token: string) {
  return {
    req: {
      header: (name: string) => {
        if (name === 'Authorization') return `Bearer ${token}`;
        return undefined;
      },
    },
    env: {
      DATABASE: {},
      JWT_PUBLIC_KEY: 'mock-key',
      BASE_DOMAIN: 'example.com',
    },
  } as any;
}

describe('verifyWorkspaceCallbackAuth — scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // CRITICAL SECURITY TEST: Node-scoped tokens MUST be rejected
  // ==========================================================================

  it('REJECTS node-scoped tokens for workspace endpoints', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-123',
      type: 'callback',
      scope: 'node',
    });

    const c = makeContext('node-scoped-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).rejects.toThrow('Node-scoped tokens cannot access workspace endpoints');
  });

  it('REJECTS node-scoped tokens even when workspace claim matches workspaceId', async () => {
    // Edge case: even if someone forges a node token with a workspace ID as the
    // workspace claim, the scope: 'node' should still block it
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-abc',
      type: 'callback',
      scope: 'node',
    });

    const c = makeContext('forged-node-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).rejects.toThrow('Node-scoped tokens cannot access workspace endpoints');
  });

  // ==========================================================================
  // Workspace-scoped tokens: should work for matching workspace
  // ==========================================================================

  it('ACCEPTS workspace-scoped tokens when workspace claim matches', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-abc',
      type: 'callback',
      scope: 'workspace',
    });

    const c = makeContext('workspace-token');

    // Should resolve without throwing
    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).resolves.toBeUndefined();
  });

  it('REJECTS workspace-scoped tokens when workspace claim does not match', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-other',
      type: 'callback',
      scope: 'workspace',
    });

    const c = makeContext('wrong-workspace-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).rejects.toThrow('Token workspace mismatch');
  });

  it('REJECTS workspace-scoped tokens for a different workspace on the same node', async () => {
    // This is the key security test: a workspace-scoped token for ws-other
    // should NOT be able to access ws-abc even if they're on the same node
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-other',
      type: 'callback',
      scope: 'workspace',
    });

    const c = makeContext('cross-workspace-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).rejects.toThrow('Token workspace mismatch');

    // Verify no DB query was made (scope: workspace does direct match only)
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Legacy tokens (no scope): backward compatible
  // ==========================================================================

  it('ACCEPTS legacy tokens with direct workspace match', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-abc',
      type: 'callback',
      // No scope — legacy token
    });

    const c = makeContext('legacy-workspace-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).resolves.toBeUndefined();
  });

  it('ACCEPTS legacy node-level tokens via node fallback (backward compatible)', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-123',
      type: 'callback',
      // No scope — legacy token
    });

    // DB returns workspace with matching nodeId
    mockDbSelect.mockResolvedValue([{ nodeId: 'node-123' }]);

    const c = makeContext('legacy-node-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).resolves.toBeUndefined();
  });

  it('REJECTS legacy tokens when neither workspace nor node matches', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'unrelated-id',
      type: 'callback',
      // No scope — legacy token
    });

    // DB returns workspace with different nodeId
    mockDbSelect.mockResolvedValue([{ nodeId: 'node-other' }]);

    const c = makeContext('bad-legacy-token');

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).rejects.toThrow('Token workspace mismatch');
  });

  // ==========================================================================
  // Missing auth header
  // ==========================================================================

  it('REJECTS requests without Authorization header', async () => {
    const c = {
      req: {
        header: () => undefined,
      },
      env: { DATABASE: {}, JWT_PUBLIC_KEY: 'key', BASE_DOMAIN: 'example.com' },
    } as any;

    await expect(
      verifyWorkspaceCallbackAuth(c, 'ws-abc')
    ).rejects.toThrow('Missing or invalid Authorization header');
  });
});
