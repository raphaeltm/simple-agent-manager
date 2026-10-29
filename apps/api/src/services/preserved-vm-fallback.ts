/** Bounded sleep decisions authorize release, never claim a complete filesystem backup. */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import * as projectData from './project-data';
import { serializeSessionSleepFallbackRecord, sleptFallbackRecord } from './session-sleep-episode';
import { persistSessionSleepFallbackNotice } from './session-sleep-fallback-notices';
import { assessSessionSleepRecoveryPoint } from './session-sleep-recovery-point';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';

export async function verifyVmFallbackRetirement(
  env: Env,
  expected: WorkspaceDeletionIdentity,
  snapshot: schema.SessionSnapshot
): Promise<boolean> {
  const record = sleptFallbackRecord(snapshot);
  if (
    !record ||
    !Number.isFinite(Date.parse(record.decidedAt)) ||
    record.failedAttempts <= 0 ||
    !expected.projectId ||
    !expected.chatSessionId ||
    !expected.nodeRuntimeIncarnationId ||
    expected.nodeUserId !== expected.userId ||
    snapshot.workspaceId !== expected.workspaceId ||
    snapshot.nodeId !== expected.nodeId ||
    snapshot.userId !== expected.userId ||
    snapshot.projectId !== expected.projectId ||
    snapshot.chatSessionId !== expected.chatSessionId ||
    snapshot.captureGeneration ||
    !['sleeping', 'stopping'].includes(snapshot.sleepStatus ?? '') ||
    (snapshot.sleepStatus === 'stopping' && !snapshot.sleepClaimId)
  )
    return false;
  let identity: Record<string, unknown>;
  try {
    identity = JSON.parse(snapshot.cleanupIdentityJson ?? 'null');
  } catch {
    return false;
  }
  if (
    !identity ||
    identity.workspaceId !== expected.workspaceId ||
    identity.nodeId !== expected.nodeId ||
    identity.userId !== expected.userId ||
    identity.workspaceGeneration !== (expected.workspaceGeneration ?? '') ||
    identity.nodeRuntimeIncarnationId !== expected.nodeRuntimeIncarnationId ||
    identity.snapshotGeneration !== snapshot.snapshotGeneration
  )
    return false;
  if (record.recoveryPoint) {
    const assessment = await assessSessionSleepRecoveryPoint(env, snapshot, new Date()).catch(
      () => ({ ok: false as const })
    );
    if (!assessment.ok) {
      // The bounded policy releases compute even when a recovery point expired or
      // disappeared. Reconcile its promise first; this authority must be prepared
      // again from the downgraded record on a later tick before any destruction.
      await drizzle(env.DATABASE, { schema })
        .update(schema.sessionSnapshots)
        .set({
          sleepFallbackJson: serializeSessionSleepFallbackRecord({
            ...record,
            recoveryPoint: null,
            decidedAt: new Date().toISOString(),
          }),
        })
        .where(
          and(
            eq(schema.sessionSnapshots.id, snapshot.id),
            eq(schema.sessionSnapshots.workspaceId, expected.workspaceId),
            sql`${schema.sessionSnapshots.cleanupIdentityJson} IS ${snapshot.cleanupIdentityJson}`,
            sql`${schema.sessionSnapshots.sleepFallbackJson} IS ${snapshot.sleepFallbackJson}`,
            sql`${schema.sessionSnapshots.snapshotGeneration} IS ${snapshot.snapshotGeneration}`,
            sql`${schema.sessionSnapshots.sleepStatus} IS ${snapshot.sleepStatus}`,
            sql`${schema.sessionSnapshots.sleepClaimId} IS ${snapshot.sleepClaimId}`,
            isNull(schema.sessionSnapshots.captureGeneration)
          )
        );
      return false;
    }
  }
  const chat = await projectData.getSession(env, expected.projectId, expected.chatSessionId);
  if (!chat || chat.workspaceId !== expected.workspaceId || chat.status !== 'sleeping')
    return false;
  // Idempotent durable notice is mandatory, including when an earlier attempt crashed
  // between its D1 decision and ProjectData write. Keep every existing backup object.
  await persistSessionSleepFallbackNotice(env, {
    projectId: expected.projectId,
    chatSessionId: expected.chatSessionId,
    record,
  });
  return true;
}
