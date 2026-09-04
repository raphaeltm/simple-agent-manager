import { DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { deleteSessionSnapshotState } from './session-snapshots';
import { attemptWorkspaceDeletion, type WorkspaceDeletionOutcome } from './workspace-deletion';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface WorkspaceDeletionCleanupOptions {
  db: Db;
  env: Env;
  workspace: schema.Workspace;
  userId: string;
  logContext?: Record<string, unknown>;
}

function workspaceDeletionRetryBaseMs(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_RETRY_BASE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WORKSPACE_DELETION_RETRY_BASE_MS;
}

export async function cleanupWorkspaceForDeletion(
  options: WorkspaceDeletionCleanupOptions
): Promise<WorkspaceDeletionOutcome> {
  const { db, env, workspace, userId, logContext = {} } = options;
  const expected = {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    userId,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
  };
  let lifecycleStub:
    | DurableObjectStub<import('../durable-objects/node-lifecycle').NodeLifecycle>
    | undefined;
  if (workspace.nodeId) {
    const doId = env.NODE_LIFECYCLE.idFromName(workspace.nodeId);
    lifecycleStub = env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<
      import('../durable-objects/node-lifecycle').NodeLifecycle
    >;
    const claimed = await lifecycleStub.claimWorkspaceDeletionAttempt(
      workspace.nodeId,
      workspace.id,
      userId,
      expected
    );
    if (!claimed) {
      return { status: 'fenced', reason: 'workspace_active' };
    }
  }
  const outcome = await attemptWorkspaceDeletion({
    env,
    expected,
    attempt: 1,
    source: String(logContext.closePath ?? 'explicit'),
    mode: 'explicit',
    beforeFinalize: workspace.chatSessionId
      ? async () => {
          await deleteSessionSnapshotState(db, env, workspace.chatSessionId as string);
        }
      : undefined,
  });

  if (outcome.status === 'confirmed' && outcome.workspaceFinalized) {
    await lifecycleStub?.confirmWorkspaceDeletion(workspace.id);
    await db
      .delete(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspace.id),
          eq(schema.workspaces.userId, userId),
          eq(schema.workspaces.status, 'deleted')
        )
      );
    return outcome;
  }

  if (outcome.status !== 'confirmed' && workspace.nodeId) {
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
