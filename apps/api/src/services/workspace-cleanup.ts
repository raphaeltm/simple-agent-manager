import { DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { deleteSessionSnapshotState } from './session-snapshots';
import {
  attemptWorkspaceDeletion,
  loadWorkspaceDeletionSnapshot,
  workspaceDeletionIdentityLogContext,
  type WorkspaceDeletionOutcome,
} from './workspace-deletion';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface WorkspaceDeletionCleanupOptions {
  db: Db;
  env: Env;
  workspace: schema.Workspace;
  userId: string;
  logContext?: Record<string, unknown>;
  /** Preserve the proof-bearing D1 tombstone after lifecycle closure. */
  deleteConfirmedRow?: boolean;
}

function workspaceDeletionRetryBaseMs(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_RETRY_BASE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS;
}

export async function cleanupWorkspaceForDeletion(
  options: WorkspaceDeletionCleanupOptions
): Promise<WorkspaceDeletionOutcome> {
  const { db, env, workspace, userId, logContext = {}, deleteConfirmedRow = true } = options;
  const expected = await loadWorkspaceDeletionSnapshot(env.DATABASE, workspace.id);
  const requestedIdentity = {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    nodeUserId: null,
    nodeRuntime: null,
    nodeProviderInstanceId: null,
    nodeRuntimeIncarnationId: null,
    userId,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
  };
  if (
    !expected ||
    expected.userId !== userId ||
    expected.nodeId !== workspace.nodeId ||
    expected.projectId !== workspace.projectId ||
    expected.chatSessionId !== workspace.chatSessionId
  ) {
    log.warn('workspace.deletion_identity_fenced', {
      ...workspaceDeletionIdentityLogContext(requestedIdentity, expected),
      reason: 'workspace_assignment_changed',
      action: 'rejected',
      ...logContext,
    });
    return { status: 'fenced', reason: 'workspace_assignment_changed' };
  }
  let lifecycleStub:
    | DurableObjectStub<import('../durable-objects/node-lifecycle').NodeLifecycle>
    | undefined;
  const deletionAlreadyProven = Boolean(
    expected.runtimeDeletionConfirmedAt && expected.runtimeDeletionProof
  );
  if (workspace.nodeId) {
    const doId = env.NODE_LIFECYCLE.idFromName(workspace.nodeId);
    lifecycleStub = env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<
      import('../durable-objects/node-lifecycle').NodeLifecycle
    >;
  }
  if (workspace.nodeId && lifecycleStub && !deletionAlreadyProven) {
    const claim = await lifecycleStub.claimWorkspaceDeletionAttempt(
      workspace.nodeId,
      workspace.id,
      userId,
      expected,
      'explicit'
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
    if (claim !== 'claimed') {
      log.warn('workspace.deletion_claim_fenced', {
        ...workspaceDeletionIdentityLogContext(expected, expected),
        reason: 'workspace_active',
        action: 'rejected',
        ...logContext,
      });
      return { status: 'fenced', reason: 'workspace_active' };
    }
  }
  const outcome = await attemptWorkspaceDeletion({
    env,
    expected,
    attempt: 1,
    source: String(logContext.closePath ?? 'explicit'),
    mode: 'explicit',
    allowWorkspaceNeverStartedProof: workspace.status === 'pending',
    beforeFinalize: workspace.chatSessionId
      ? async () => {
          await deleteSessionSnapshotState(db, env, workspace.chatSessionId as string);
        }
      : undefined,
  });

  if (outcome.status === 'confirmed') {
    await lifecycleStub?.confirmWorkspaceDeletion(workspace.id);
    if (deleteConfirmedRow) {
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
    return outcome;
  }

  if (outcome.status === 'superseded') {
    await lifecycleStub?.confirmWorkspaceDeletion(workspace.id);
    return outcome;
  }

  if (workspace.nodeId) {
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

  return outcome;
}
