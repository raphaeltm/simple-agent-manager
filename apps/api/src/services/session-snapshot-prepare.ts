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
        inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed', 'preparing'])
      )
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
        throw new Error('Snapshot capture lost the sleep teardown race');
      }
    } else {
      const result = await db.update(schema.sessionSnapshots).set(row).where(captureAllowed);
      if ((result.meta.changes ?? 0) === 0) {
        throw new Error('Snapshot capture lost the sleep teardown race');
      }
    }
  } else {
    await db.insert(schema.sessionSnapshots).values({ ...row, createdAt: now.toISOString() });
  }

  return { snapshotId, generation, expiresAt, keys, config };
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
