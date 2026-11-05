import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { verifySessionSnapshotArtifactsForSleep } from './session-snapshot-artifacts';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';
import {
  preservationReceiptExpiresAt,
  preservationReceiptStatement,
} from './workspace-preservation-receipt';

/**
 * Snapshot recovery states in which a wake still holds the snapshot's claim. A wake releases the
 * old workspace's chat binding in the transaction that claims the snapshot (`createRecoveryTask` in
 * `session-recovery.ts`), and a completed sleep resets `recovery_status` to NULL, so these states
 * are exactly the ones that explain a released binding (`claimStillOwned` in
 * `session-recovery-handoff.ts` uses the same set). `recovery_task_id` alone is not enough: it is
 * never cleared.
 */
export const WAKE_CLAIM_RECOVERY_STATUSES = ['waking', 'failed', 'restored'] as const;

/**
 * The conversation the workspace's snapshot belongs to. A slept workspace whose wake is in flight,
 * stuck or finished has no binding left, but its snapshot still names it exactly, so that
 * snapshot's own conversation is used while the wake claim explains the released binding. Any
 * other unbound workspace stays unpreserved. Without this, the deletion queue deferred such a
 * workspace forever and its node could only be retired by the stranded-node deadline (idea
 * 01M6K6R2255R7414WSER4N3STJ, node 01M6F4WPF51FYE55F3FVHJ6YAZ).
 */
async function findPreservationSnapshot(env: Env, expected: WorkspaceDeletionIdentity) {
  if (!expected.projectId || !expected.nodeId) return null;
  const snapshots = await drizzle(env.DATABASE, { schema })
    .select()
    .from(schema.sessionSnapshots)
    .where(
      and(
        expected.chatSessionId
          ? eq(schema.sessionSnapshots.chatSessionId, expected.chatSessionId)
          : and(
              isNotNull(schema.sessionSnapshots.recoveryTaskId),
              inArray(schema.sessionSnapshots.recoveryStatus, WAKE_CLAIM_RECOVERY_STATUSES)
            ),
        eq(schema.sessionSnapshots.workspaceId, expected.workspaceId),
        eq(schema.sessionSnapshots.nodeId, expected.nodeId),
        eq(schema.sessionSnapshots.userId, expected.userId),
        eq(schema.sessionSnapshots.projectId, expected.projectId)
      )
    )
    .limit(2)
    .all();
  // More than one candidate is ambiguous, so the workspace stays unpreserved.
  const [snapshot, ...others] = snapshots;
  return snapshot?.chatSessionId && others.length === 0 ? snapshot : null;
}

/** Status/age/pressure are scheduling hints, never authority to discard user data. */
export async function automaticDeletionPreservationExpiresAt(
  env: Env,
  expected: WorkspaceDeletionIdentity,
  purpose: 'workspace_deletion' | 'vm_retirement' = 'workspace_deletion'
): Promise<string | null> {
  if (
    !expected.projectId ||
    !expected.nodeId ||
    !expected.nodeRuntimeIncarnationId ||
    expected.nodeUserId !== expected.userId
  )
    return null;
  // The source's own receipt survives the replacement rewriting the per-chat snapshot
  // row. Rows preserved before receipts existed fall through to the snapshot-row path.
  const receiptExpiresAt = await preservationReceiptExpiresAt(env, expected);
  if (receiptExpiresAt) return receiptExpiresAt;
  const snapshot = await findPreservationSnapshot(env, expected);
  if (
    !snapshot ||
    snapshot.status !== 'available' ||
    snapshot.degradation !== 'none' ||
    !snapshot.cleanupIdentityJson ||
    snapshot.captureGeneration ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    Date.parse(snapshot.expiresAt) <= Date.now()
  )
    return null;
  // The eviction callback also marks the snapshot sleeping, but an evicted source anchors
  // its wake until a replacement restores it (see `preservationReceiptExpiresAt`).
  // `eviction_recovery_workspace_id` is written once at eviction and never cleared; workspace
  // ids are never reused, so it names only the evicted source.
  const evictionSource = snapshot.evictionRecoveryWorkspaceId === expected.workspaceId;
  const completedSleep =
    !evictionSource &&
    snapshot.sleepStatus === 'sleeping' &&
    (Boolean(snapshot.sleepingAt) || purpose === 'vm_retirement');
  if (!completedSleep) {
    if (
      snapshot.recoveryStatus !== 'restored' ||
      !snapshot.recoveryWorkspaceId ||
      snapshot.recoveryWorkspaceId === expected.workspaceId ||
      !snapshot.restoredAt
    )
      return null;
    const target = await drizzle(env.DATABASE, { schema })
      .select({
        userId: schema.workspaces.userId,
        projectId: schema.workspaces.projectId,
        chatSessionId: schema.workspaces.chatSessionId,
        status: schema.workspaces.status,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, snapshot.recoveryWorkspaceId))
      .get();
    if (
      !target ||
      target.userId !== expected.userId ||
      target.projectId !== expected.projectId ||
      target.chatSessionId !== snapshot.chatSessionId ||
      !['running', 'recovery', 'sleeping'].includes(target.status)
    )
      return null;
    // An evicted source anchors its wake until that wake commits: the eviction fence and the
    // failed-wake retry both require it.
    if (evictionSource && !(await evictionWakeCommitted(env, snapshot))) return null;
  }
  let identity: Record<string, unknown>;
  try {
    identity = JSON.parse(snapshot.cleanupIdentityJson);
  } catch {
    return null;
  }
  if (
    !identity ||
    identity.preserved !== 1 ||
    identity.snapshotGeneration !== snapshot.snapshotGeneration ||
    identity.workspaceId !== expected.workspaceId ||
    identity.nodeId !== expected.nodeId ||
    identity.userId !== expected.userId ||
    identity.nodeRuntimeIncarnationId !== expected.nodeRuntimeIncarnationId ||
    identity.workspaceGeneration !== (expected.workspaceGeneration ?? '')
  )
    return null;
  if (
    !(await verifySessionSnapshotArtifactsForSleep(env, snapshot)) ||
    Date.parse(snapshot.expiresAt) <= Date.now()
  )
    return null;
  // Backfill the durable receipt while the row still names this workspace: covers rows
  // preserved before receipts existed and a receipt write lost after a sleep finalized.
  await preservationReceiptStatement(env.DATABASE, {
    chatSessionId: snapshot.chatSessionId,
    reason:
      snapshot.evictionRecoveryWorkspaceId === expected.workspaceId ? 'quiesced_eviction' : 'sleep',
    nowIso: new Date().toISOString(),
  })
    .run()
    .catch((error: unknown) => {
      log.warn('workspace_deletion.preservation_receipt_backfill_failed', {
        workspaceId: expected.workspaceId,
        chatSessionId: snapshot.chatSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return snapshot.expiresAt;
}

/**
 * The wake that restored the snapshot row `alias` committed: the commit
 * (`transitionToInProgress`) starts the recovery task after the restore, so a start before it
 * belongs to an earlier run of that task. Shared with the stale-workspace sweep.
 */
export function evictionWakeCommittedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${alias}.recovery_task_id
    AND ${alias}.restored_at IS NOT NULL AND t.started_at >= ${alias}.restored_at)`;
}

/** The same check for a loaded snapshot row (`evictionWakeCommittedSql`). */
async function evictionWakeCommitted(
  env: Env,
  snapshot: { recoveryTaskId: string | null; restoredAt: string | null }
): Promise<boolean> {
  if (!snapshot.recoveryTaskId || !snapshot.restoredAt) return false;
  const task = await drizzle(env.DATABASE, { schema })
    .select({ startedAt: schema.tasks.startedAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, snapshot.recoveryTaskId))
    .get();
  return Boolean(task?.startedAt && task.startedAt >= snapshot.restoredAt);
}

export async function automaticDeletionPreservationAvailable(
  env: Env,
  expected: WorkspaceDeletionIdentity
): Promise<boolean> {
  return (await automaticDeletionPreservationExpiresAt(env, expected)) !== null;
}
