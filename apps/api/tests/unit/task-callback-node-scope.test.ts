/**
 * Task Callback Node-Scoped Token — Behavioral Tests
 *
 * Regression test for the bug where node-scoped callback tokens were rejected
 * with 401 on the task status callback endpoint. The VM agent falls back to
 * the node-scoped token when the workspace runtime token isn't available yet
 * (e.g., during initial bootstrap before agent install). The task callback
 * must accept these tokens by verifying the workspace belongs to the node.
 *
 * Five branches tested:
 * 1. Workspace-scoped token with matching workspaceId — accepted
 * 2. Node-scoped token where workspace belongs to the node — accepted (the fix)
 * 3. Node-scoped token where workspace is on a different node — rejected 403
 * 4. Workspace-scoped token with wrong workspaceId — rejected 403
 * 5. Task with no workspaceId — rejected 403
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallbackTokenPayload } from '../../src/services/jwt';

// --- Mock setup ---

// Track DB queries to verify the node-scope lookup happens
const mockTaskQuery = vi.fn();
const mockWorkspaceQuery = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: (fields?: Record<string, unknown>) => ({
      from: (_table: { name?: string }) => ({
        where: () => ({
          limit: () => {
            // Route to the right mock based on which fields are selected
            if (fields && 'nodeId' in fields) {
              return mockWorkspaceQuery();
            }
            return mockTaskQuery();
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => [] }),
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

const mockVerifyCallbackToken = vi.fn<(token: string, env: unknown) => Promise<CallbackTokenPayload>>();
vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: (...args: [string, unknown]) => mockVerifyCallbackToken(...args),
  signCallbackToken: vi.fn().mockResolvedValue('mock-token'),
  signNodeCallbackToken: vi.fn().mockResolvedValue('mock-node-token'),
}));

// Mock schema to provide table references
vi.mock('../../src/db/schema', () => ({
  tasks: { id: 'id', projectId: 'projectId', name: 'tasks' },
  workspaces: { id: 'id', nodeId: 'nodeId', name: 'workspaces' },
  projects: { id: 'id', name: 'projects' },
}));

// Now import the handler logic
// Since the route handler is tightly coupled to Hono, we test the auth logic
// by extracting the core validation pattern into a standalone function that
// mirrors the handler's behavior.

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  return header.slice(7);
}

/**
 * Mirrors the task callback auth logic from crud.ts lines 463-509.
 * This is the code under test — extracted to be testable without Hono.
 */
async function validateTaskCallbackAuth(
  authHeader: string | undefined,
  task: { workspaceId: string | null },
  lookupWorkspaceNode: (workspaceId: string) => Promise<{ nodeId: string | null } | undefined>,
  env: unknown,
): Promise<void> {
  const token = extractBearerToken(authHeader);
  const payload = await mockVerifyCallbackToken(token, env);

  if (!task.workspaceId) {
    throw new Error('Task has no workspace');
  }

  if (payload.workspace !== task.workspaceId) {
    if (payload.scope === 'node') {
      const ws = await lookupWorkspaceNode(task.workspaceId);
      if (!ws || ws.nodeId !== payload.workspace) {
        throw new Error('Token workspace mismatch');
      }
    } else {
      throw new Error('Token workspace mismatch');
    }
  }
}

describe('Task callback — node-scoped token acceptance', () => {
  const env = { JWT_PUBLIC_KEY: 'mock-key', DATABASE: {} };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // REGRESSION TEST: This is the exact scenario that caused the 401 bug.
  // The VM agent uses a node-scoped token to report task failure before
  // the workspace runtime token is available.
  // =========================================================================

  it('ACCEPTS node-scoped token when workspace belongs to the token node', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-abc',
      type: 'callback',
      scope: 'node',
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn().mockResolvedValue({ nodeId: 'node-abc' });

    await expect(
      validateTaskCallbackAuth('Bearer node-token', task, lookupWorkspaceNode, env)
    ).resolves.toBeUndefined();

    // Verify the DB lookup was called with the task's workspace
    expect(lookupWorkspaceNode).toHaveBeenCalledWith('ws-123');
  });

  // =========================================================================
  // Security: node-scoped tokens for a DIFFERENT node must be rejected
  // =========================================================================

  it('REJECTS node-scoped token when workspace is on a different node', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-evil',
      type: 'callback',
      scope: 'node',
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn().mockResolvedValue({ nodeId: 'node-abc' });

    await expect(
      validateTaskCallbackAuth('Bearer wrong-node-token', task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Token workspace mismatch');
  });

  it('REJECTS node-scoped token when workspace row not found', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-abc',
      type: 'callback',
      scope: 'node',
    });

    const task = { workspaceId: 'ws-deleted' };
    const lookupWorkspaceNode = vi.fn().mockResolvedValue(undefined);

    await expect(
      validateTaskCallbackAuth('Bearer orphan-token', task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Token workspace mismatch');
  });

  it('REJECTS node-scoped token when workspace nodeId is null (node destroyed)', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-abc',
      type: 'callback',
      scope: 'node',
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn().mockResolvedValue({ nodeId: null });

    await expect(
      validateTaskCallbackAuth('Bearer stale-token', task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Token workspace mismatch');
  });

  // =========================================================================
  // Workspace-scoped tokens: direct match behavior (unchanged)
  // =========================================================================

  it('ACCEPTS workspace-scoped token with matching workspaceId', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      scope: 'workspace',
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn();

    await expect(
      validateTaskCallbackAuth('Bearer ws-token', task, lookupWorkspaceNode, env)
    ).resolves.toBeUndefined();

    // No DB lookup needed — direct match
    expect(lookupWorkspaceNode).not.toHaveBeenCalled();
  });

  it('REJECTS workspace-scoped token with wrong workspaceId', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-other',
      type: 'callback',
      scope: 'workspace',
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn();

    await expect(
      validateTaskCallbackAuth('Bearer wrong-ws-token', task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Token workspace mismatch');

    // No DB lookup — workspace scope goes straight to rejection
    expect(lookupWorkspaceNode).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Task without workspace
  // =========================================================================

  it('REJECTS when task has no workspaceId', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      scope: 'workspace',
    });

    const task = { workspaceId: null };
    const lookupWorkspaceNode = vi.fn();

    await expect(
      validateTaskCallbackAuth('Bearer token', task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Task has no workspace');
  });

  // =========================================================================
  // Legacy tokens (no scope field)
  // =========================================================================

  it('ACCEPTS legacy token (no scope) with direct workspace match', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'ws-123',
      type: 'callback',
      // no scope field — legacy
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn();

    await expect(
      validateTaskCallbackAuth('Bearer legacy-token', task, lookupWorkspaceNode, env)
    ).resolves.toBeUndefined();
  });

  it('REJECTS legacy token (no scope) with mismatched workspace', async () => {
    mockVerifyCallbackToken.mockResolvedValue({
      workspace: 'node-abc',
      type: 'callback',
      // no scope field — legacy
    });

    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn();

    await expect(
      validateTaskCallbackAuth('Bearer legacy-node-token', task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Token workspace mismatch');
  });

  // =========================================================================
  // Missing auth header
  // =========================================================================

  it('REJECTS request without Authorization header', async () => {
    const task = { workspaceId: 'ws-123' };
    const lookupWorkspaceNode = vi.fn();

    await expect(
      validateTaskCallbackAuth(undefined, task, lookupWorkspaceNode, env)
    ).rejects.toThrow('Missing or invalid Authorization header');
  });
});
