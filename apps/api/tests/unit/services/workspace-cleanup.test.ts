import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Workspace } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { cleanupWorkspaceForDeletion } from '../../../src/services/workspace-cleanup';
import { workspaceDeletionIdentityLogContext } from '../../../src/services/workspace-deletion';

const mocks = vi.hoisted(() => ({
  attemptWorkspaceDeletion: vi.fn(),
  loadWorkspaceDeletionSnapshot: vi.fn(),
  claimWorkspaceDeletionAttempt: vi.fn(),
  confirmWorkspaceDeletion: vi.fn(),
  scheduleWorkspaceDeletion: vi.fn(),
  deleteSessionSnapshotState: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../../../src/services/workspace-deletion', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/services/workspace-deletion')>();
  return {
    ...actual,
    attemptWorkspaceDeletion: (...args: unknown[]) => mocks.attemptWorkspaceDeletion(...args),
    loadWorkspaceDeletionSnapshot: (...args: unknown[]) =>
      mocks.loadWorkspaceDeletionSnapshot(...args),
  };
});
vi.mock('../../../src/services/session-snapshots', () => ({
  deleteSessionSnapshotState: (...args: unknown[]) => mocks.deleteSessionSnapshotState(...args),
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: mocks.logWarn },
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
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValue('claimed');
    mocks.scheduleWorkspaceDeletion.mockResolvedValue(undefined);
    mocks.deleteSessionSnapshotState.mockResolvedValue(true);
    mocks.loadWorkspaceDeletionSnapshot.mockResolvedValue({
      workspaceId: 'ws-cleanup-1',
      nodeId: 'node-cleanup-1',
      nodeUserId: 'user-cleanup-1',
      nodeRuntime: 'vm',
      nodeProviderInstanceId: 'provider-node-cleanup-1',
      nodeRuntimeIncarnationId: 'runtime-node-cleanup-1',
      userId: 'user-cleanup-1',
      projectId: 'project-cleanup-1',
      chatSessionId: 'session-cleanup-1',
      status: 'stopped',
      runtimeDeletionConfirmedAt: null,
      runtimeDeletionProof: null,
    });
  });

  it('emits the complete bounded identity field set without arbitrary payloads', () => {
    expect(
      workspaceDeletionIdentityLogContext(
        {
          workspaceId: 'workspace-expected',
          userId: 'user-expected',
          projectId: 'project-expected',
          chatSessionId: 'session-expected',
          nodeId: 'node-expected',
          nodeUserId: 'node-user-expected',
          nodeRuntime: 'vm',
          nodeProviderInstanceId: 'provider-expected',
          nodeRuntimeIncarnationId: 'runtime-expected',
        },
        {
          workspaceId: 'workspace-current',
          userId: 'user-current',
          projectId: 'project-current',
          chatSessionId: 'session-current',
          nodeId: 'node-current',
          nodeUserId: 'node-user-current',
          nodeRuntime: 'cf-container',
          nodeProviderInstanceId: 'provider-current',
          nodeRuntimeIncarnationId: 'runtime-current',
        }
      )
    ).toEqual({
      expectedWorkspaceId: 'workspace-expected',
      currentWorkspaceId: 'workspace-current',
      expectedUserId: 'user-expected',
      currentUserId: 'user-current',
      expectedProjectId: 'project-expected',
      currentProjectId: 'project-current',
      expectedChatSessionId: 'session-expected',
      currentChatSessionId: 'session-current',
      expectedNodeId: 'node-expected',
      currentNodeId: 'node-current',
      expectedNodeUserId: 'node-user-expected',
      currentNodeUserId: 'node-user-current',
      expectedNodeRuntime: 'vm',
      currentNodeRuntime: 'cf-container',
      expectedNodeProviderInstanceId: 'provider-expected',
      currentNodeProviderInstanceId: 'provider-current',
      expectedNodeRuntimeIncarnationId: 'runtime-expected',
      currentNodeRuntimeIncarnationId: 'runtime-current',
    });
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
      expect.objectContaining({ workspaceId: 'ws-cleanup-1' }),
      'explicit'
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
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValueOnce('fenced');

    const outcome = await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(outcome).toEqual({ status: 'fenced', reason: 'workspace_active' });
    expect(mocks.attemptWorkspaceDeletion).not.toHaveBeenCalled();
    expect(deletedTables).toEqual([]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'workspace.deletion_claim_fenced',
      expect.objectContaining({
        expectedWorkspaceId: 'ws-cleanup-1',
        currentWorkspaceId: 'ws-cleanup-1',
        expectedUserId: 'user-cleanup-1',
        currentUserId: 'user-cleanup-1',
        expectedProjectId: 'project-cleanup-1',
        currentProjectId: 'project-cleanup-1',
        expectedChatSessionId: 'session-cleanup-1',
        currentChatSessionId: 'session-cleanup-1',
        expectedNodeId: 'node-cleanup-1',
        currentNodeId: 'node-cleanup-1',
        action: 'rejected',
      })
    );
  });

  it('reports an identical already-claimed deletion as durably pending', async () => {
    const { db, deletedTables } = buildDb();
    mocks.claimWorkspaceDeletionAttempt.mockResolvedValueOnce('already_claimed_same_identity');

    const outcome = await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(outcome).toEqual({
      status: 'retry',
      reason: 'runtime_deletion_unconfirmed',
      diagnostic: 'Workspace deletion unconfirmed: durable attempt already in progress',
    });
    expect(mocks.attemptWorkspaceDeletion).not.toHaveBeenCalled();
    expect(deletedTables).toEqual([]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'workspace.deletion_claim_contended',
      expect.objectContaining({ action: 'existing_attempt_retained' })
    );
  });

  it('logs full bounded identity context when the route snapshot is stale', async () => {
    const { db, deletedTables } = buildDb();
    mocks.loadWorkspaceDeletionSnapshot.mockResolvedValueOnce({
      workspaceId: 'ws-cleanup-1',
      nodeId: 'node-cleanup-2',
      nodeUserId: 'user-cleanup-2',
      nodeRuntime: 'vm',
      nodeProviderInstanceId: 'provider-node-cleanup-2',
      nodeRuntimeIncarnationId: 'runtime-node-cleanup-2',
      userId: 'user-cleanup-2',
      projectId: 'project-cleanup-2',
      chatSessionId: 'session-cleanup-2',
      status: 'running',
      runtimeDeletionConfirmedAt: null,
      runtimeDeletionProof: null,
    });

    const outcome = await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace(),
      userId: 'user-cleanup-1',
    });

    expect(outcome).toEqual({ status: 'fenced', reason: 'workspace_assignment_changed' });
    expect(mocks.claimWorkspaceDeletionAttempt).not.toHaveBeenCalled();
    expect(mocks.attemptWorkspaceDeletion).not.toHaveBeenCalled();
    expect(deletedTables).toEqual([]);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'workspace.deletion_identity_fenced',
      expect.objectContaining({
        expectedWorkspaceId: 'ws-cleanup-1',
        currentWorkspaceId: 'ws-cleanup-1',
        expectedUserId: 'user-cleanup-1',
        currentUserId: 'user-cleanup-2',
        expectedProjectId: 'project-cleanup-1',
        currentProjectId: 'project-cleanup-2',
        expectedChatSessionId: 'session-cleanup-1',
        currentChatSessionId: 'session-cleanup-2',
        expectedNodeId: 'node-cleanup-1',
        currentNodeId: 'node-cleanup-2',
        expectedNodeRuntime: null,
        currentNodeRuntime: 'vm',
        expectedNodeUserId: null,
        currentNodeUserId: 'user-cleanup-2',
        expectedNodeProviderInstanceId: null,
        currentNodeProviderInstanceId: 'provider-node-cleanup-2',
        expectedNodeRuntimeIncarnationId: null,
        currentNodeRuntimeIncarnationId: 'runtime-node-cleanup-2',
        action: 'rejected',
      })
    );
  });

  it('does not hard-delete an incarnation that changed before confirmation finalized', async () => {
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
        expected: expect.objectContaining({
          workspaceId: 'ws-cleanup-1',
          nodeId: 'node-cleanup-1',
          nodeUserId: 'user-cleanup-1',
          nodeRuntime: 'vm',
          nodeProviderInstanceId: 'provider-node-cleanup-1',
          nodeRuntimeIncarnationId: 'runtime-node-cleanup-1',
          userId: 'user-cleanup-1',
          projectId: 'project-cleanup-1',
          chatSessionId: 'session-cleanup-1',
        }),
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

  it('allows never-started proof only for an originally and currently pending no-node workspace', async () => {
    const { db } = buildDb();
    mocks.loadWorkspaceDeletionSnapshot.mockResolvedValueOnce({
      workspaceId: 'ws-cleanup-1',
      nodeId: null,
      nodeUserId: null,
      nodeRuntime: null,
      nodeProviderInstanceId: null,
      nodeRuntimeIncarnationId: null,
      userId: 'user-cleanup-1',
      projectId: 'project-cleanup-1',
      chatSessionId: 'session-cleanup-1',
      status: 'pending',
      runtimeDeletionConfirmedAt: null,
      runtimeDeletionProof: null,
    });
    mocks.attemptWorkspaceDeletion.mockResolvedValueOnce({
      status: 'confirmed',
      proof: 'workspace_never_started',
      workspaceFinalized: true,
    });

    await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace({ nodeId: null, status: 'pending' }),
      userId: 'user-cleanup-1',
    });

    expect(mocks.attemptWorkspaceDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ allowWorkspaceNeverStartedProof: true })
    );
  });

  it('withholds never-started proof from a non-pending no-node workspace', async () => {
    const { db } = buildDb();
    mocks.loadWorkspaceDeletionSnapshot.mockResolvedValueOnce({
      workspaceId: 'ws-cleanup-1',
      nodeId: null,
      nodeUserId: null,
      nodeRuntime: null,
      nodeProviderInstanceId: null,
      nodeRuntimeIncarnationId: null,
      userId: 'user-cleanup-1',
      projectId: 'project-cleanup-1',
      chatSessionId: 'session-cleanup-1',
      status: 'running',
      runtimeDeletionConfirmedAt: null,
      runtimeDeletionProof: null,
    });
    mocks.attemptWorkspaceDeletion.mockResolvedValueOnce({
      status: 'retry',
      reason: 'runtime_deletion_unconfirmed',
      diagnostic: 'node assignment unavailable',
    });

    await cleanupWorkspaceForDeletion({
      db: db as never,
      env: buildEnv(),
      workspace: workspace({ nodeId: null, status: 'running' }),
      userId: 'user-cleanup-1',
    });

    expect(mocks.attemptWorkspaceDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ allowWorkspaceNeverStartedProof: false })
    );
    expect(mocks.confirmWorkspaceDeletion).not.toHaveBeenCalled();
  });
});
