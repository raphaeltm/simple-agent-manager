import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { cleanupWorkspaceForDeletion } from '../../../src/services/workspace-cleanup';

const mocks = vi.hoisted(() => ({
  attemptWorkspaceDeletion: vi.fn(),
  claimWorkspaceDeletionAttempt: vi.fn(),
  confirmWorkspaceDeletion: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  deleteSessionSnapshotState: vi.fn(),
}));

vi.mock('../../../src/services/workspace-deletion', () => ({
  attemptWorkspaceDeletion: (...args: unknown[]) => mocks.attemptWorkspaceDeletion(...args),
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  deleteSessionSnapshotState: (...args: unknown[]) => mocks.deleteSessionSnapshotState(...args),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function buildDb() {
  const deletedTables: string[] = [];
  const deleteFn = vi.fn((table: { _: { name?: string }; [key: symbol]: unknown }) => {
    deletedTables.push(String(table[Symbol.for('drizzle:Name')] ?? table._.name ?? 'unknown'));
    return { where: vi.fn(async () => undefined) };
  });
  return { db: { delete: deleteFn }, deletedTables };
}

function buildEnv(): Env {
  return {
    NODE_LIFECYCLE: {
      idFromName: vi.fn(() => 'node-lifecycle-id'),
      get: vi.fn(() => ({
        claimWorkspaceDeletionAttempt: mocks.claimWorkspaceDeletionAttempt,
        confirmWorkspaceDeletion: mocks.confirmWorkspaceDeletion,
        scheduleWorkspaceDeletion: mocks.scheduleWorkspaceDeletion,
      })),
    },
  } as unknown as Env;
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
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValue(true);
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.deleteSessionSnapshotState.mockResolvedValue(true);
  });

  it('hard-deletes local state only after confirmed runtime deletion and lifecycle finalization', async () => {
    const { db, deletedTables } = buildDb();
    const env = buildEnv();
    mocks.attemptWorkspaceDeletion.mockImplementationOnce(
      async (options: { beforeFinalize?: () => Promise<void> }) => {
        await options.beforeFinalize?.();
        return { status: 'confirmed', proof: 'vm_agent_confirmed', workspaceFinalized: true };
      }
    );

    const outcome = await cleanupWorkspaceForDeletion({
      db: db as never,
      env,
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(outcome).toMatchObject({ status: 'confirmed', proof: 'vm_agent_confirmed' });
    expect(mocks.deleteSessionSnapshotState).toHaveBeenCalledWith(db, env, 'session-cleanup-1');
    expect(mocks.claimWorkspaceDeletionAttempt).toHaveBeenCalledWith(
      'node-cleanup-1',
      'ws-cleanup-1',
      'user-cleanup-1',
      expect.objectContaining({ workspaceId: 'ws-cleanup-1' })
    );
    expect(mocks.claimWorkspaceDeletionAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.attemptWorkspaceDeletion.mock.invocationCallOrder[0] as number
    );
    expect(mocks.confirmWorkspaceDeletion).toHaveBeenCalledWith('ws-cleanup-1');
    expect(deletedTables).toEqual(['workspaces']);
    expect(mocks.scheduleWorkspaceDeletion).not.toHaveBeenCalled();
  });

  it('does not open a VM request when the durable attempt claim is already owned', async () => {
    const { db, deletedTables } = buildDb();
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValueOnce(false);

    const outcome = await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(outcome).toEqual({ status: 'fenced', reason: 'workspace_active' });
    expect(mocks.attemptWorkspaceDeletion).not.toHaveBeenCalled();
    expect(deletedTables).toEqual([]);
  });

  it('does not hard-delete an incarnation that changed before confirmation finalized', async () => {
    const { db, deletedTables } = buildDb();
    mocks.attemptWorkspaceDeletion.mockResolvedValueOnce({
      status: 'confirmed',
      proof: 'vm_agent_confirmed',
      workspaceFinalized: false,
    });

    await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(deletedTables).toEqual([]);
    expect(mocks.confirmWorkspaceDeletion).not.toHaveBeenCalled();
  });

  it('keeps a failed VM deletion retryable without deleting snapshots or D1 workspace state', async () => {
    const { db, deletedTables } = buildDb();
    const env = buildEnv();
    mocks.attemptWorkspaceDeletion.mockResolvedValueOnce({
      status: 'retry',
      reason: 'runtime_deletion_unconfirmed',
      diagnostic: 'VM deletion unconfirmed after attempt 1: timeout',
    });

    const outcome = await cleanupWorkspaceForDeletion({
      db: db as never,
      env,
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(outcome.status).toBe('retry');
    expect(deletedTables).toEqual([]);
    expect(mocks.deleteSessionSnapshotState).not.toHaveBeenCalled();
    expect(mocks.confirmWorkspaceDeletion).not.toHaveBeenCalled();
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledWith(
      'node-cleanup-1',
      'ws-cleanup-1',
      'user-cleanup-1',
      expect.objectContaining({
        lastError: expect.stringContaining('timeout'),
        expected: {
          workspaceId: 'ws-cleanup-1',
          nodeId: 'node-cleanup-1',
          userId: 'user-cleanup-1',
          projectId: 'project-cleanup-1',
          chatSessionId: 'session-cleanup-1',
        },
      })
    );
  });

  it('retains an ownership-changed deletion as a fenced pending operation', async () => {
    const { db, deletedTables } = buildDb();
    mocks.attemptWorkspaceDeletion.mockResolvedValueOnce({
      status: 'fenced',
      reason: 'workspace_assignment_changed',
    });

    await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(deletedTables).toEqual([]);
    expect(mocks.scheduleWorkspaceDeletion).toHaveBeenCalledOnce();
  });
});
