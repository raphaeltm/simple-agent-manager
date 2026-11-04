import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { verifySessionSnapshotArtifactsForSleep } from './session-snapshot-artifacts';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';

/**
 * The conversation the workspace's snapshot belongs to. A wake releases the old workspace's chat
 * binding in the transaction that claims the snapshot (`createRecoveryTask` in
 * `session-recovery.ts`), so a slept workspace whose wake is in flight, or stuck, has no binding
 * left. Its snapshot still names it exactly, so that snapshot's own conversation is used, but only
 * when the snapshot carries the wake claim that explains the released binding. Any other unbound
 * workspace stays unpreserved. Without this, the deletion queue deferred such a workspace forever
 * and its node could only be retired by the stranded-node deadline (idea 01M6K6R2255R7414WSER4N3STJ,
 * node 01M6F4WPF51FYE55F3FVHJ6YAZ).
 */
async function findPreservationSnapshot(env: Env, expected: WorkspaceDeletionIdentity) {
  if (!expected.projectId || !expected.nodeId) return null;
  const snapshot = await drizzle(env.DATABASE, { schema })
    .select()
    .from(schema.sessionSnapshots)
    .where(
      and(
        expected.chatSessionId
          ? eq(schema.sessionSnapshots.chatSessionId, expected.chatSessionId)
          : isNotNull(schema.sessionSnapshots.recoveryTaskId),
        eq(schema.sessionSnapshots.workspaceId, expected.workspaceId),
        eq(schema.sessionSnapshots.nodeId, expected.nodeId),
        eq(schema.sessionSnapshots.userId, expected.userId),
        eq(schema.sessionSnapshots.projectId, expected.projectId)
      )
    )
    .get();
  return snapshot?.chatSessionId ? snapshot : null;
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
  const completedSleep =
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
  return snapshot.expiresAt;
}

export async function automaticDeletionPreservationAvailable(
  env: Env,
  expected: WorkspaceDeletionIdentity
): Promise<boolean> {
  return (await automaticDeletionPreservationExpiresAt(env, expected)) !== null;
}
