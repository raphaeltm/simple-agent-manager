import { DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopNodeResources } from './node-resource-lifecycle';
import { handOffEmptyWorkspaceNode } from './node-warm-handoff';
import { deleteSessionSnapshotState } from './session-snapshots';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionSnapshot,
  terminalNodeProof,
  workspaceDeletionIdentityLogContext,
  type WorkspaceDeletionMode,
  type WorkspaceDeletionOutcome,
  type WorkspaceDeletionSnapshot,
} from './workspace-deletion';
import { automaticDeletionPreservationAvailable } from './workspace-deletion-preservation';
import { deleteWorkspaceResourceHistoryObjectsForWorkspace } from './workspace-resource-history';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface WorkspaceDeletionCleanupOptions {
  db: Db;
  env: Env;
  workspace: schema.Workspace;
  userId: string;
  logContext?: Record<string, unknown>;
  /** Preserve the proof-bearing D1 tombstone after lifecycle closure. */
  deleteConfirmedRow?: boolean;
  mode?: WorkspaceDeletionMode;
  requireRuntimeTerminationProof?: boolean;
}

function workspaceDeletionRetryBaseMs(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_RETRY_BASE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS;
}

type NodeLifecycleStub = DurableObjectStub<
  import('../durable-objects/node-lifecycle').NodeLifecycle
>;

function workspaceDeletionLogSource(logContext: Record<string, unknown>): string {
  return typeof logContext.closePath === 'string' ? logContext.closePath : 'explicit';
}

function requestedWorkspaceDeletionIdentity(workspace: schema.Workspace, userId: string) {
  return {
    workspaceId: workspace.id,
    workspaceGeneration: workspace.evictionGeneration,
    nodeId: workspace.nodeId,
    nodeUserId: null,
    nodeRuntime: null,
    nodeProviderInstanceId: null,
    nodeRuntimeIncarnationId: null,
    userId,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
  };
}

function deletionSnapshotMatchesRequest(
  expected: WorkspaceDeletionSnapshot | null,
  workspace: schema.Workspace,
  userId: string
): expected is NonNullable<typeof expected> {
  return (
    expected?.userId === userId &&
    (expected.workspaceGeneration ?? null) === (workspace.evictionGeneration ?? null) &&
    expected.nodeId === workspace.nodeId &&
    expected.projectId === workspace.projectId &&
    expected.chatSessionId === workspace.chatSessionId
  );
}

function nodeLifecycleStub(env: Env, nodeId: string | null): NodeLifecycleStub | undefined {
  if (!nodeId) return undefined;
  return env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(nodeId)) as NodeLifecycleStub;
}

async function claimExplicitWorkspaceDeletion(
  lifecycleStub: NodeLifecycleStub | undefined,
  workspace: schema.Workspace,
  userId: string,
  expected: WorkspaceDeletionSnapshot,
  logContext: Record<string, unknown>,
  mode: WorkspaceDeletionMode
): Promise<WorkspaceDeletionOutcome | null> {
  const deletionAlreadyProven = Boolean(
    expected.runtimeDeletionConfirmedAt && expected.runtimeDeletionProof
  );
  if (!workspace.nodeId || !lifecycleStub || deletionAlreadyProven) return null;

  const claim = await lifecycleStub.claimWorkspaceDeletionAttempt(
    workspace.nodeId,
    workspace.id,
    userId,
    expected,
    mode
  );
  if (claim === 'already_claimed_same_identity') {
    const diagnostic = 'Workspace deletion unconfirmed: durable attempt already in progress';
    log.warn('workspace.deletion_claim_contended', {
      ...workspaceDeletionIdentityLogContext(expected, expected),
      reason: 'runtime_deletion_unconfirmed',
      action: 'existing_attempt_retained',
      ...logContext,
    });
    return { status: 'retry', reason: 'runtime_deletion_unconfirmed', diagnostic };
  }
  if (claim === 'claimed') return null;

  log.warn('workspace.deletion_claim_fenced', {
    ...workspaceDeletionIdentityLogContext(expected, expected),
    reason: 'workspace_active',
    action: 'rejected',
    ...logContext,
  });
  return { status: 'fenced', reason: 'workspace_active' };
}

async function finishConfirmedWorkspaceCleanup(
  db: Db,
  env: Env,
  lifecycleStub: NodeLifecycleStub | undefined,
  workspace: schema.Workspace,
  userId: string,
  deleteConfirmedRow: boolean
): Promise<void> {
  await lifecycleStub?.confirmWorkspaceDeletion(workspace.id);
  if (!deleteConfirmedRow) return;
  if (workspace.projectId) {
    try {
      const stats = await deleteWorkspaceResourceHistoryObjectsForWorkspace(
        env,
        workspace.projectId,
        workspace.id
      );
      log.info('workspace.resource_history_cleanup_completed', {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        prefix: stats.prefix,
        listedObjects: stats.listedObjects,
        deletedObjects: stats.deletedObjects,
        truncated: stats.truncated,
      });
    } catch (error) {
      log.warn('workspace.resource_history_cleanup_failed', {
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await db
    .delete(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.id, workspace.id),
        eq(schema.workspaces.userId, userId),
        eq(schema.workspaces.status, 'deleted')
      )
    );
}

async function schedulePendingWorkspaceDeletion(
  lifecycleStub: NodeLifecycleStub | undefined,
  workspace: schema.Workspace,
  userId: string,
  env: Env,
  expected: WorkspaceDeletionSnapshot,
  outcome: Exclude<WorkspaceDeletionOutcome, { status: 'confirmed' | 'superseded' }>,
  logContext: Record<string, unknown>
): Promise<void> {
  if (!workspace.nodeId) return;
  await lifecycleStub?.scheduleWorkspaceDeletion(workspace.nodeId, workspace.id, userId, {
    retryAfterMs: workspaceDeletionRetryBaseMs(env),
    lastError: outcome.status === 'retry' ? outcome.diagnostic : outcome.reason,
    expected,
  });
  log.warn('workspace.deletion_pending', {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    userId,
    outcome: outcome.status,
    reason: outcome.reason,
    ...logContext,
  });
}

export async function cleanupWorkspaceForDeletion(
  options: WorkspaceDeletionCleanupOptions
): Promise<WorkspaceDeletionOutcome> {
  const {
    db,
    env,
    workspace,
    userId,
    logContext = {},
    deleteConfirmedRow = true,
    mode = 'explicit',
  } = options;
  const expected = await loadWorkspaceDeletionSnapshot(env.DATABASE, workspace.id);
  const requestedIdentity = requestedWorkspaceDeletionIdentity(workspace, userId);
  if (!deletionSnapshotMatchesRequest(expected, workspace, userId)) {
    log.warn('workspace.deletion_identity_fenced', {
      ...workspaceDeletionIdentityLogContext(requestedIdentity, expected),
      reason: 'workspace_assignment_changed',
      action: 'rejected',
      ...logContext,
    });
    return { status: 'fenced', reason: 'workspace_assignment_changed' };
  }
  const runtimeAlreadyTerminated =
    mode === 'automatic' ? await terminalNodeProof(env.DATABASE, expected) : null;
  if (options.requireRuntimeTerminationProof && !runtimeAlreadyTerminated) {
    return {
      status: 'retry',
      reason: 'runtime_deletion_unconfirmed',
      diagnostic: 'Workspace deletion unconfirmed: strict node termination proof required',
    };
  }
  if (
    mode === 'automatic' &&
    !runtimeAlreadyTerminated &&
    !expected.runtimeDeletionConfirmedAt &&
    !(await automaticDeletionPreservationAvailable(env, expected).catch(() => false))
  ) {
    return {
      status: 'retry',
      reason: 'preservation_unconfirmed',
      diagnostic: 'Workspace deletion unconfirmed: exact runtime preservation unavailable',
    };
  }
  const lifecycleStub = nodeLifecycleStub(env, workspace.nodeId);
  const claimOutcome = runtimeAlreadyTerminated
    ? null
    : await claimExplicitWorkspaceDeletion(
        lifecycleStub,
        workspace,
        userId,
        expected,
        logContext,
        mode
      );
  if (claimOutcome) return claimOutcome;

  const outcome = await attemptWorkspaceDeletion({
    env,
    expected,
    attempt: 1,
    source: workspaceDeletionLogSource(logContext),
    mode,
    allowWorkspaceNeverStartedProof: workspace.status === 'pending',
    beforeFinalize:
      mode === 'explicit' && workspace.chatSessionId && workspace.projectId
        ? async () => {
            const chatSessionId = workspace.chatSessionId as string;
            await deleteSessionSnapshotState(db, env, chatSessionId, expected);
          }
        : undefined,
  });

  if (outcome.status === 'confirmed') {
    await finishConfirmedWorkspaceCleanup(
      db,
      env,
      lifecycleStub,
      workspace,
      userId,
      deleteConfirmedRow
    );
    if (workspace.nodeId && expected.nodeRuntime === 'cf-container' && !runtimeAlreadyTerminated) {
      try {
        await stopNodeResources(workspace.nodeId, userId, env, {
          expectedRuntime: {
            userId: expected.nodeUserId ?? userId,
            runtime: expected.nodeRuntime,
            providerInstanceId: expected.nodeProviderInstanceId,
            runtimeIncarnationId: expected.nodeRuntimeIncarnationId,
          },
        });
      } catch (error) {
        // A sibling/placement still owns compute, or teardown must be retried by
        // the normal node reconciler. Source physical deletion remains confirmed.
        log.warn('workspace.confirmed_container_retirement_deferred', {
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (workspace.nodeId) {
      // Archive and delete end most conversations; the node they leave empty must reach
      // NodeLifecycle now rather than wait for the cleanup sweep's backstop.
      await handOffEmptyWorkspaceNode(env, {
        nodeId: workspace.nodeId,
        expectedUserId: userId,
        sourceProjectId: workspace.projectId,
        reason: 'workspace_deleted',
      });
    }
    return outcome;
  }

  if (outcome.status === 'superseded') {
    await lifecycleStub?.confirmWorkspaceDeletion(workspace.id);
    return outcome;
  }

  await schedulePendingWorkspaceDeletion(
    lifecycleStub,
    workspace,
    userId,
    env,
    expected,
    outcome,
    logContext
  );

  return outcome;
}
