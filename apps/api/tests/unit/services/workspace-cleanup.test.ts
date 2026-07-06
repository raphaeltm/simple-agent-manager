import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { cleanupWorkspaceForDeletion } from '../../../src/services/workspace-cleanup';

const mocks = vi.hoisted(() => ({
  deleteWorkspaceOnNode: vi.fn(),
  stopComputeTracking: vi.fn(),
  stopSession: vi.fn(),
  cleanupWorkspaceActivity: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  deleteWorkspaceOnNode: (...args: unknown[]) => mocks.deleteWorkspaceOnNode(...args),
}));
vi.mock('../../../src/services/compute-usage', () => ({
  stopComputeTracking: (...args: unknown[]) => mocks.stopComputeTracking(...args),
}));
vi.mock('../../../src/services/project-data', () => ({
  stopSession: (...args: unknown[]) => mocks.stopSession(...args),
  cleanupWorkspaceActivity: (...args: unknown[]) => mocks.cleanupWorkspaceActivity(...args),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn() },
}));

function buildDb(nodeRows: unknown[]) {
  const deletedTables: string[] = [];
  const select = vi.fn(() => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => Promise.resolve(nodeRows)),
    };
    return chain;
  });
  const deleteFn = vi.fn((table: { _: { name?: string }; [key: symbol]: unknown }) => {
    deletedTables.push(String(table[Symbol.for('drizzle:Name')] ?? table._.name ?? 'unknown'));
    return {
      where: vi.fn(() => Promise.resolve()),
    };
  });

  return { db: { select, delete: deleteFn }, deletedTables };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-cleanup-1',
    userId: 'user-cleanup-1',
    nodeId: 'node-cleanup-1',
    projectId: 'project-cleanup-1',
    installationId: null,
    name: 'cleanup workspace',
    normalizedDisplayName: null,
    displayName: null,
    repository: 'acme/repo',
    branch: 'main',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    workspaceProfile: 'default',
    devcontainerConfigName: null,
    hetznerServerId: null,
    vmIp: null,
    dnsRecordId: null,
    lastActivityAt: null,
    chatSessionId: 'session-cleanup-1',
    portsPublicEnabled: false,
    errorMessage: null,
    dispatchedAt: null,
    agentProfileHint: null,
    resourceRequirementsJson: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('cleanupWorkspaceForDeletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteWorkspaceOnNode.mockResolvedValue(undefined);
    mocks.stopComputeTracking.mockResolvedValue(undefined);
    mocks.stopSession.mockResolvedValue(undefined);
    mocks.cleanupWorkspaceActivity.mockResolvedValue(undefined);
  });

  it('deletes the workspace row immediately after best-effort runtime cleanup', async () => {
    const { db, deletedTables } = buildDb([{ status: 'running', healthStatus: 'healthy' }]);
    const env = {} as Env;
    const waitUntil = vi.fn();

    await cleanupWorkspaceForDeletion({
      db: db as never,
      env,
      workspace: workspace(),
      userId: 'user-cleanup-1',
      waitUntil,
    });

    expect(mocks.deleteWorkspaceOnNode).toHaveBeenCalledWith(
      'node-cleanup-1',
      'ws-cleanup-1',
      env,
      'user-cleanup-1',
    );
    expect(mocks.stopComputeTracking).toHaveBeenCalledWith(db, 'ws-cleanup-1');
    expect(deletedTables).toEqual(['agent_sessions', 'workspaces']);
    expect(waitUntil).toHaveBeenCalledTimes(2);
  });

  it('still deletes D1 workspace state when the node delete call fails', async () => {
    const { db, deletedTables } = buildDb([{ status: 'running', healthStatus: 'healthy' }]);
    mocks.deleteWorkspaceOnNode.mockRejectedValueOnce(new Error('node unavailable'));

    await cleanupWorkspaceForDeletion({
      db: db as never,
      env: {} as Env,
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(deletedTables).toContain('workspaces');
  });
});
