import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import {
  buildSessionSnapshotR2Key,
  getSessionSnapshotConfig,
  type PrepareSessionSnapshotInput,
  type SessionSnapshotArtifact,
  type SessionSnapshotConfig,
} from './session-snapshot-artifacts';
import {
  deleteAbandonedSessionSnapshotObjects,
  sessionSnapshotCaptureKeys,
} from './session-snapshot-capture-cleanup';
import { ensureUnhealthyNodeSleepPlaceholder } from './session-snapshot-unhealthy-guard';

type Db = ReturnType<typeof drizzle<typeof schema>>;

function snapshotExpiry(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export async function prepareSessionSnapshot(
  db: Db,
  env: Env,
  input: PrepareSessionSnapshotInput
): Promise<{
  snapshotId: string;
  generation: string;
  expiresAt: string;
  keys: Record<SessionSnapshotArtifact, string>;
  config: SessionSnapshotConfig;
}> {
  const config = getSessionSnapshotConfig(env);
  const now = new Date();
  const expiresAt = snapshotExpiry(now, config.ttlDays);
  const generation = ulid();
  const keys = {
    home: buildSessionSnapshotR2Key(env, input.chatSessionId, generation, 'home'),
    wip: buildSessionSnapshotR2Key(env, input.chatSessionId, generation, 'wip'),
    manifest: buildSessionSnapshotR2Key(env, input.chatSessionId, generation, 'manifest'),
  };

  const existing = await db
    .select({
      id: schema.sessionSnapshots.id,
      status: schema.sessionSnapshots.status,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
      captureGeneration: schema.sessionSnapshots.captureGeneration,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .limit(1);

  const snapshotId = existing[0]?.id || ulid();
  const row = {
    id: snapshotId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    userId: input.userId,
    chatSessionId: input.chatSessionId,
    agentSessionId: input.agentSessionId,
    runtime: input.runtime,
    status: 'pending',
    degradation: 'none',
    homeR2Key: keys.home,
    wipR2Key: keys.wip,
    manifestR2Key: keys.manifest,
    baseCommit: null,
    expiresAt,
    manifestJson: null,
    restoreStatus: null,
    restoreMessage: null,
    restoredAt: null,
    sleepingAt: null,
    recoveryStatus: null,
    recoveryTaskId: null,
    recoveryWorkspaceId: null,
    recoveryAttempts: 0,
    recoveryFailedAt: null,
    recoveryError: null,
    recoveryClaimedAt: null,
    snapshotGeneration: null,
    captureGeneration: generation,
    captureError: null,
    authorizedHomeBytes: null,
    authorizedHomeSha256: null,
    authorizedWipBytes: null,
    authorizedWipSha256: null,
    homeSha256: null,
    wipSha256: null,
    updatedAt: now.toISOString(),
  } satisfies schema.NewSessionSnapshot;

  if (existing[0]) {
    const current = existing[0];
    if (
      current.sleepingAt ||
      current.sleepStatus === 'sleeping' ||
      current.sleepStatus === 'stopping'
    ) {
      throw new Error('Snapshot capture cannot start after sleep teardown was claimed');
    }
    const captureAllowed = and(
      eq(schema.sessionSnapshots.id, snapshotId),
      isNull(schema.sessionSnapshots.sleepingAt),
      or(
        isNull(schema.sessionSnapshots.sleepStatus),
        inArray(schema.sessionSnapshots.sleepStatus, CAPTURE_ALLOWED_SLEEP_STATUSES)
      ),
      // Compare-and-swap on the capture this prepare replaces. If a completion
      // or another prepare moved the row since the read, overwriting it would
      // clobber a just-completed snapshot, and the superseded-capture cleanup
      // below would then delete that snapshot's objects.
      current.captureGeneration === null
        ? isNull(schema.sessionSnapshots.captureGeneration)
        : eq(schema.sessionSnapshots.captureGeneration, current.captureGeneration)
    );
    if (current.status === 'available' || current.status === 'degraded') {
      // A checkpoint upload is not the current snapshot until completion
      // certifies it. Preserve the last complete generation and lifecycle state
      // so an interrupted capture cannot make a sleeping session unwakeable.
      const result = await db
        .update(schema.sessionSnapshots)
        .set({
          workspaceId: input.workspaceId,
          nodeId: input.nodeId,
          projectId: input.projectId,
          userId: input.userId,
          agentSessionId: input.agentSessionId,
          runtime: input.runtime,
          captureGeneration: generation,
          captureError: null,
          authorizedHomeBytes: null,
          authorizedHomeSha256: null,
          authorizedWipBytes: null,
          authorizedWipSha256: null,
          updatedAt: now.toISOString(),
        })
        .where(captureAllowed);
      if ((result.meta.changes ?? 0) === 0) {
        throw new Error(await lostCaptureRaceMessage(db, snapshotId));
      }
    } else {
      const result = await db.update(schema.sessionSnapshots).set(row).where(captureAllowed);
      if ((result.meta.changes ?? 0) === 0) {
        throw new Error(await lostCaptureRaceMessage(db, snapshotId));
      }
    }
    if (current.captureGeneration && current.captureGeneration !== generation) {
      await deleteSupersededCapture(db, env, input.chatSessionId, current.captureGeneration);
    }
  } else {
    await db.insert(schema.sessionSnapshots).values({ ...row, createdAt: now.toISOString() });
  }

  return { snapshotId, generation, expiresAt, keys, config };
}

const CAPTURE_ALLOWED_SLEEP_STATUSES = ['scheduled', 'failed', 'preparing'];

/** Names which race a prepare lost, for the capture failure it reports. */
async function lostCaptureRaceMessage(db: Db, snapshotId: string): Promise<string> {
  const row = await db
    .select({
      sleepingAt: schema.sessionSnapshots.sleepingAt,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.id, snapshotId))
    .get();
  const teardownClaimed =
    Boolean(row?.sleepingAt) ||
    (row?.sleepStatus != null && !CAPTURE_ALLOWED_SLEEP_STATUSES.includes(row.sleepStatus));
  return teardownClaimed
    ? 'Snapshot capture lost the sleep teardown race'
    : 'Snapshot capture lost a race with a concurrent capture or completion';
}

/**
 * The capture generation this prepare replaced can no longer complete (its
 * /complete is rejected as not current), so its uploads are abandoned. The
 * row's recorded keys are re-read after the replacement and always kept: they
 * belong to the completed snapshot, including the case where the superseded
 * capture completed between the read and the replacement.
 */
async function deleteSupersededCapture(
  db: Db,
  env: Env,
  chatSessionId: string,
  supersededGeneration: string
): Promise<void> {
  const recorded = await db
    .select({
      homeR2Key: schema.sessionSnapshots.homeR2Key,
      wipR2Key: schema.sessionSnapshots.wipR2Key,
      manifestR2Key: schema.sessionSnapshots.manifestR2Key,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  await deleteAbandonedSessionSnapshotObjects(env, {
    chatSessionId,
    generation: supersededGeneration,
    keys: sessionSnapshotCaptureKeys(env, chatSessionId, supersededGeneration),
    keep: [recorded?.homeR2Key, recorded?.wipR2Key, recorded?.manifestR2Key],
  });
}

/**
 * Establishes the D1 lifecycle lock row before a first checkpoint exists.
 * Explicit/task-completion sleep can therefore claim the session while an
 * idle checkpoint is still running (or before the idle callback arrives).
 * The placeholder generation is never restorable and writes no R2 objects.
 */
export async function ensureSessionSnapshotForSleep(
  db: Db,
  env: Env,
  input: PrepareSessionSnapshotInput,
  options: { expectedNodeId?: string } = {}
): Promise<boolean> {
  const now = new Date();
  const placeholderGeneration = ulid();
  const row = {
    id: ulid(),
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    nodeId: input.nodeId,
    userId: input.userId,
    chatSessionId: input.chatSessionId,
    agentSessionId: input.agentSessionId,
    runtime: input.runtime,
    status: 'pending',
    degradation: 'none',
    manifestR2Key: buildSessionSnapshotR2Key(
      env,
      input.chatSessionId,
      placeholderGeneration,
      'manifest'
    ),
    expiresAt: snapshotExpiry(now, getSessionSnapshotConfig(env).ttlDays),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (options.expectedNodeId) {
    return ensureUnhealthyNodeSleepPlaceholder(env, row, options.expectedNodeId);
  }
  await db
    .insert(schema.sessionSnapshots)
    .values(row)
    .onConflictDoUpdate({
      target: schema.sessionSnapshots.chatSessionId,
      // Recovery can move a conversation to a replacement workspace. Refresh
      // only ownership/routing metadata here: the last verified generation and
      // all sleep/recovery lifecycle state remain authoritative until the final
      // capture replaces them.
      set: {
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        nodeId: input.nodeId,
        userId: input.userId,
        agentSessionId: input.agentSessionId,
        runtime: input.runtime,
        updatedAt: now.toISOString(),
      },
    });
  return true;
}
