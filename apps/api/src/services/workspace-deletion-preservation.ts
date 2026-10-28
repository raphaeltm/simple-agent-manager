import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { verifySessionSnapshotArtifactsForSleep } from './session-snapshot-artifacts';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';

/** Status/age/pressure are scheduling hints, never authority to discard user data. */
export async function automaticDeletionPreservationAvailable(
  env: Env,
  expected: WorkspaceDeletionIdentity
): Promise<boolean> {
  if (
    !expected.chatSessionId ||
    !expected.projectId ||
    !expected.nodeId ||
    !expected.nodeRuntimeIncarnationId ||
    expected.nodeUserId !== expected.userId
  )
    return false;
  const snapshot = await drizzle(env.DATABASE, { schema })
    .select()
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, expected.chatSessionId),
        eq(schema.sessionSnapshots.workspaceId, expected.workspaceId),
        eq(schema.sessionSnapshots.nodeId, expected.nodeId),
        eq(schema.sessionSnapshots.userId, expected.userId),
        eq(schema.sessionSnapshots.projectId, expected.projectId)
      )
    )
    .get();
  if (
    !snapshot ||
    snapshot.status !== 'available' ||
    snapshot.degradation !== 'none' ||
    !snapshot.cleanupIdentityJson ||
    snapshot.captureGeneration ||
    snapshot.expiresAt <= new Date().toISOString()
  )
    return false;
  const completedSleep = snapshot.sleepStatus === 'sleeping' && Boolean(snapshot.sleepingAt);
  if (!completedSleep) {
    if (
      snapshot.recoveryStatus !== 'restored' ||
      !snapshot.recoveryWorkspaceId ||
      snapshot.recoveryWorkspaceId === expected.workspaceId ||
      !snapshot.restoredAt
    )
      return false;
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
      target.chatSessionId !== expected.chatSessionId ||
      !['running', 'recovery', 'sleeping'].includes(target.status)
    )
      return false;
  }
  let identity: Record<string, unknown>;
  try {
    identity = JSON.parse(snapshot.cleanupIdentityJson);
  } catch {
    return false;
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
    return false;
  return verifySessionSnapshotArtifactsForSleep(env, snapshot);
}
