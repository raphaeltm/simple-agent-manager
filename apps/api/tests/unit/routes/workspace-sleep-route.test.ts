import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { lifecycleRoutes } from '../../../src/routes/workspaces/lifecycle';
import { createRouteTestApp } from './route-test-app';

const mocks = vi.hoisted(() => ({
  getUserId: vi.fn(() => 'user-sleep-1'),
  requireApprovedMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireAuthMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  sleepWorkspaceSession: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => mocks.getUserId(),
  requireApproved: () => mocks.requireApprovedMiddleware,
  requireAuth: () => mocks.requireAuthMiddleware,
}));
vi.mock('../../../src/services/boot-log', () => ({
  writeBootLogs: vi.fn(),
}));
vi.mock('../../../src/services/compute-usage', () => ({
  stopComputeTracking: vi.fn(),
}));
vi.mock('../../../src/services/node-agent', () => ({
  rebuildWorkspaceOnNode: vi.fn(),
  restartWorkspaceOnNode: vi.fn(),
  stopWorkspaceOnNode: vi.fn(),
}));
vi.mock('../../../src/services/nodes', () => ({
  stopNodeResources: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => ({
  cleanupWorkspaceActivity: vi.fn(),
  stopSession: vi.fn(),
}));
vi.mock('../../../src/services/session-sleep', () => ({
  sleepWorkspaceSession: mocks.sleepWorkspaceSession,
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  deleteSessionSnapshotState: vi.fn(),
}));
vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: vi.fn(),
}));

function buildDb(workspaces: unknown[]) {
  const limit = vi.fn(async () => workspaces);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select, from, where, limit };
}

function buildEnv(): Env {
  return {
    DATABASE: {} as D1Database,
  } as Env;
}

describe('POST /api/workspaces/:id/sleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockReturnValue('user-sleep-1');
    mocks.sleepWorkspaceSession.mockResolvedValue({
      status: 'sleeping',
      workspaceId: 'workspace-sleep-1',
      chatSessionId: 'chat-sleep-1',
      snapshotExpiresAt: '2026-08-28T00:00:00.000Z',
    });
  });

  it('requires browser auth/approval, verifies same-user ownership, and delegates to sleep service', async () => {
    const db = buildDb([
      {
        id: 'workspace-sleep-1',
        userId: 'user-sleep-1',
        projectId: 'project-sleep-1',
        nodeId: 'node-sleep-1',
        chatSessionId: 'chat-sleep-1',
        status: 'running',
      },
    ]);
    vi.mocked(drizzle).mockReturnValue(db as never);
    const env = buildEnv();

    const response = await createRouteTestApp('/api/workspaces', lifecycleRoutes).request(
      '/api/workspaces/workspace-sleep-1/sleep',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'sleeping',
      workspaceId: 'workspace-sleep-1',
      chatSessionId: 'chat-sleep-1',
      snapshotExpiresAt: '2026-08-28T00:00:00.000Z',
    });
    expect(mocks.requireAuthMiddleware).toHaveBeenCalledTimes(1);
    expect(mocks.requireApprovedMiddleware).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.limit).toHaveBeenCalledWith(1);
    expect(mocks.sleepWorkspaceSession).toHaveBeenCalledWith(env, {
      workspaceId: 'workspace-sleep-1',
      userId: 'user-sleep-1',
      reason: 'Explicit workspace sleep API request',
    });
  });

  it('does not sleep when the workspace is not owned by the caller', async () => {
    const db = buildDb([]);
    vi.mocked(drizzle).mockReturnValue(db as never);

    const response = await createRouteTestApp('/api/workspaces', lifecycleRoutes).request(
      '/api/workspaces/workspace-other-user/sleep',
      { method: 'POST' },
      buildEnv()
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Workspace not found',
    });
    expect(mocks.sleepWorkspaceSession).not.toHaveBeenCalled();
  });

  it('returns conflict instead of a platform 500 when explicit sleep is safely deferred', async () => {
    const db = buildDb([
      {
        id: 'workspace-sleep-1',
        userId: 'user-sleep-1',
        projectId: 'project-sleep-1',
        nodeId: 'node-sleep-1',
        chatSessionId: 'chat-sleep-1',
        status: 'running',
      },
    ]);
    vi.mocked(drizzle).mockReturnValue(db as never);
    mocks.sleepWorkspaceSession.mockRejectedValue(
      new Error('Harness-owned background work is active')
    );

    const response = await createRouteTestApp('/api/workspaces', lifecycleRoutes).request(
      '/api/workspaces/workspace-sleep-1/sleep',
      { method: 'POST' },
      buildEnv()
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'CONFLICT',
      message: 'Harness-owned background work is active',
    });
  });
});
