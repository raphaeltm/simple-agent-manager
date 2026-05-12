/**
 * Behavioral tests for workspace dispatch guard.
 *
 * The primary behavioral coverage lives in the Miniflare integration tests
 * (tests/workers/workspace-dispatch-guard.test.ts) which exercise real D1
 * queries proving the filter works.
 *
 * These tests verify the dispatch marker logic at the function level:
 * - scheduleWorkspaceCreateOnNode sets dispatchedToAgentAt before the VM call
 * - scheduleWorkspaceCreateOnNode clears dispatchedToAgentAt on failure (safety net)
 */
import { describe, expect, it, vi } from 'vitest';

// Mock external dependencies
vi.mock('../../src/services/jwt', () => ({
  signCallbackToken: vi.fn().mockResolvedValue('mock-token'),
  verifyCallbackToken: vi.fn(),
  signNodeCallbackToken: vi.fn(),
  signNodeManagementToken: vi.fn(),
  shouldRefreshCallbackToken: vi.fn(),
}));

vi.mock('../../src/services/node-agent', () => ({
  createWorkspaceOnNode: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => {
  const chainable = () => {
    const obj: Record<string, unknown> = {};
    obj.set = vi.fn().mockReturnValue(obj);
    obj.where = vi.fn().mockResolvedValue(undefined);
    return obj;
  };
  return {
    drizzle: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue(chainable()),
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }) }),
    }),
  };
});

import { createWorkspaceOnNode } from '../../src/services/node-agent';

describe('scheduleWorkspaceCreateOnNode dispatch marker', () => {
  it('sets dispatchedToAgentAt before calling createWorkspaceOnNode', async () => {
    const callOrder: string[] = [];

    // Track the order of operations via mock implementations
    const { drizzle } = await import('drizzle-orm/d1');
    const mockUpdate = vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        if (payload.dispatchedToAgentAt) {
          callOrder.push('set-dispatch-marker');
        }
        if (payload.status === 'error') {
          callOrder.push('set-error-status');
        }
        return chain;
      });
      chain.where = vi.fn().mockResolvedValue(undefined);
      return chain;
    });

    vi.mocked(drizzle).mockReturnValue({
      update: mockUpdate,
    } as never);

    vi.mocked(createWorkspaceOnNode).mockImplementation(async () => {
      callOrder.push('create-workspace-on-node');
    });

    // Import fresh to pick up mocks
    const { scheduleWorkspaceCreateOnNode } = await import('../../src/routes/workspaces/_helpers');

    const mockEnv = { DATABASE: {} } as never;
    await scheduleWorkspaceCreateOnNode(
      mockEnv, 'ws-1', 'node-1', 'user-1', 'org/repo', 'main',
    );

    // Dispatch marker must be set BEFORE the VM agent call
    expect(callOrder.indexOf('set-dispatch-marker')).toBeLessThan(
      callOrder.indexOf('create-workspace-on-node'),
    );
  });

  it('clears dispatchedToAgentAt on VM agent call failure', async () => {
    let errorPayload: Record<string, unknown> | null = null;

    const { drizzle } = await import('drizzle-orm/d1');
    const mockUpdate = vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.set = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        if (payload.status === 'error') {
          errorPayload = payload;
        }
        return chain;
      });
      chain.where = vi.fn().mockResolvedValue(undefined);
      return chain;
    });

    vi.mocked(drizzle).mockReturnValue({
      update: mockUpdate,
    } as never);

    vi.mocked(createWorkspaceOnNode).mockRejectedValue(new Error('VM agent unreachable'));

    const { scheduleWorkspaceCreateOnNode } = await import('../../src/routes/workspaces/_helpers');

    const mockEnv = { DATABASE: {} } as never;
    await scheduleWorkspaceCreateOnNode(
      mockEnv, 'ws-1', 'node-1', 'user-1', 'org/repo', 'main',
    );

    // On failure, dispatchedToAgentAt should be cleared so safety net can recover
    expect(errorPayload).not.toBeNull();
    expect(errorPayload!.dispatchedToAgentAt).toBeNull();
    expect(errorPayload!.status).toBe('error');
  });
});
