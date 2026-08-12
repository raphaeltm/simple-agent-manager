import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  buildSessionSnapshotR2Key,
  type CompleteSessionSnapshotInput,
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
  DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
  getSessionSnapshotConfig,
  sessionLifecycleError,
  type SessionSnapshotRecoveryClaim,
  type SessionSnapshotSleepClaim,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SnapshotLeaseEnv = Env & {
  SESSION_SLEEP_CLAIM_LEASE_MS?: string;
  SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS?: string;
  SESSION_SLEEP_RETRY_DELAY_MS?: string;
  SESSION_SLEEP_MAX_ATTEMPTS?: string;
  SESSION_LIFECYCLE_ERROR_MAX_LENGTH?: string;
};

function snapshotExpiry(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

function sessionSleepClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
  );
}

function sessionRecoveryClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_CLAIM_LEASE_MS
  );
}

export async function claimSessionSnapshotSleep(
  db: Db,
  env: Env,
  input: {
    chatSessionId: string;
    claimId: string;
    now?: Date;
    force?: boolean;
  }
): Promise<SessionSnapshotSleepClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - sessionSleepClaimLeaseMs(env)).toISOString();
  const maxAttempts = parsePositiveInt((env as SnapshotLeaseEnv).SESSION_SLEEP_MAX_ATTEMPTS, 3);
  const dueCondition = input.force
    ? or(
        isNull(schema.sessionSnapshots.sleepStatus),
        inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed'])
      )
    : and(
        inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed']),
        lte(schema.sessionSnapshots.sleepAfter, nowIso)
      );
  const completeSnapshotCondition = input.force
    ? inArray(schema.sessionSnapshots.status, [
        'pending',
        'available',
        'degraded',
        'failed',
        'expired',
      ])
    : and(
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none')
      );
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'preparing',
      sleepAfter: null,
      sleepClaimId: input.claimId,
      sleepClaimedAt: nowIso,
      sleepAttempts: sql`${schema.sessionSnapshots.sleepAttempts} + 1`,
      sleepError: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        completeSnapshotCondition,
        isNull(schema.sessionSnapshots.sleepingAt),
        lt(schema.sessionSnapshots.sleepAttempts, maxAttempts),
        or(
          dueCondition,
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
            or(
              isNull(schema.sessionSnapshots.sleepClaimedAt),
              lte(schema.sessionSnapshots.sleepClaimedAt, staleBefore)
            )
          )
        )
      )
    );
  if ((result.meta.changes ?? 0) > 0) {
    return { status: 'claimed', claimId: input.claimId, phase: 'preparing' };
  }

  // `stopping` is the point of no return: a crashed owner is reclaimed and
  // rolled forward without consuming the pre-teardown retry budget.
  const stopping = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepClaimId: input.claimId,
      sleepClaimedAt: nowIso,
      sleepAfter: null,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
        or(
          lte(schema.sessionSnapshots.sleepAfter, nowIso),
          isNull(schema.sessionSnapshots.sleepClaimedAt),
          lte(schema.sessionSnapshots.sleepClaimedAt, staleBefore)
        )
      )
    );
  if ((stopping.meta.changes ?? 0) > 0) {
    return { status: 'claimed', claimId: input.claimId, phase: 'stopping' };
  }

  const snapshot = await db
    .select({
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepClaimId: schema.sessionSnapshots.sleepClaimId,
      sleepAttempts: schema.sessionSnapshots.sleepAttempts,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .get();
  if (snapshot?.sleepClaimId === input.claimId && snapshot.sleepStatus === 'preparing') {
    return { status: 'claimed', claimId: input.claimId, phase: 'preparing' };
  }
  if (snapshot?.sleepClaimId === input.claimId && snapshot.sleepStatus === 'stopping') {
    return { status: 'claimed', claimId: input.claimId, phase: 'stopping' };
  }
  const reason = !snapshot
    ? 'snapshot_missing'
    : snapshot.sleepingAt
      ? 'already_sleeping'
      : snapshot.status !== 'available' || snapshot.degradation !== 'none'
        ? 'snapshot_not_complete'
        : snapshot.sleepAttempts >= maxAttempts
          ? 'sleep_attempts_exhausted'
          : 'sleep_claim_unavailable';
  return { status: 'unavailable', reason };
}

export async function beginSessionSnapshotStopping(
  db: Db,
  chatSessionId: string,
  claimId: string,
  now = new Date()
): Promise<boolean> {
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'stopping',
      sleepAfter: null,
      sleepClaimedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
        eq(schema.sessionSnapshots.sleepClaimId, claimId),
        isNull(schema.sessionSnapshots.sleepingAt)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

export async function deferSessionSnapshotStopping(
  db: Db,
  env: Env,
  chatSessionId: string,
  claimId: string,
  error: string,
  now = new Date()
): Promise<boolean> {
  const retryDelayMs = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_RETRY_DELAY_MS,
    5 * 60 * 1000
  );
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepAfter: new Date(now.getTime() + retryDelayMs).toISOString(),
      sleepError: sessionLifecycleError(env, error),
      sleepClaimedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
        eq(schema.sessionSnapshots.sleepClaimId, claimId)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

export async function failSessionSnapshotSleepBeforeTeardown(
  db: Db,
  env: Env,
  chatSessionId: string,
  claimId: string,
  error: string,
  now = new Date()
): Promise<boolean> {
  const retryDelayMs = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_RETRY_DELAY_MS,
    5 * 60 * 1000
  );
  const maxAttempts = parsePositiveInt((env as SnapshotLeaseEnv).SESSION_SLEEP_MAX_ATTEMPTS, 3);
  const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'failed',
      sleepAfter: sql`CASE WHEN ${schema.sessionSnapshots.sleepAttempts} >= ${maxAttempts} THEN NULL ELSE ${retryAt} END`,
      sleepError: sessionLifecycleError(env, error),
      sleepClaimId: null,
      sleepClaimedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
        eq(schema.sessionSnapshots.sleepClaimId, claimId)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

export async function markSessionSnapshotSleeping(
  db: Db,
  chatSessionId: string,
  now?: Date
): Promise<boolean>;
export async function markSessionSnapshotSleeping(
  db: Db,
  env: Env,
  chatSessionId: string,
  now?: Date
): Promise<boolean>;
export async function markSessionSnapshotSleeping(
  db: Db,
  envOrChatSessionId: Env | string,
  chatSessionIdOrNow?: string | Date,
  maybeNow = new Date()
): Promise<boolean> {
  const env = typeof envOrChatSessionId === 'string' ? undefined : envOrChatSessionId;
  const chatSessionId =
    typeof envOrChatSessionId === 'string' ? envOrChatSessionId : String(chatSessionIdOrNow);
  const now = chatSessionIdOrNow instanceof Date ? chatSessionIdOrNow : maybeNow;
  return markSessionSnapshotSleepingWithConfig(db, env, chatSessionId, now);
}

async function markSessionSnapshotSleepingWithConfig(
  db: Db,
  env: Env | undefined,
  chatSessionId: string,
  now: Date,
  claimId?: string
): Promise<boolean> {
  const ttlDays = env ? getSessionSnapshotConfig(env).ttlDays : DEFAULT_SESSION_SNAPSHOT_TTL_DAYS;
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepingAt: now.toISOString(),
      expiresAt: snapshotExpiry(now, ttlDays),
      recoveryStatus: null,
      recoveryError: null,
      sleepStatus: 'sleeping',
      sleepAfter: null,
      sleepError: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none'),
        ...(claimId
          ? [
              eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
              eq(schema.sessionSnapshots.sleepClaimId, claimId),
            ]
          : [])
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

export async function finalizeSessionSnapshotSleeping(
  db: Db,
  env: Env,
  chatSessionId: string,
  claimId: string,
  now = new Date()
): Promise<boolean> {
  return markSessionSnapshotSleepingWithConfig(db, env, chatSessionId, now, claimId);
}

export async function scheduleSessionSnapshotSleep(
  db: Db,
  env: Env,
  chatSessionId: string,
  now = new Date()
): Promise<void> {
  const sleepAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'scheduled',
      sleepAfter: new Date(now.getTime() + sleepAfterMs).toISOString(),
      sleepAttempts: 0,
      sleepError: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none'),
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          isNull(schema.sessionSnapshots.sleepStatus),
          inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed'])
        )
      )
    );
}

export async function cancelScheduledSessionSleep(db: Db, chatSessionId: string): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: null,
      sleepAfter: null,
      sleepError: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          isNull(schema.sessionSnapshots.sleepStatus),
          inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed', 'preparing'])
        )
      )
    );
}

/** Explicit archive/delete is destructive: remove object state before metadata. */
export async function deleteSessionSnapshotState(
  db: Db,
  env: Env,
  chatSessionId: string
): Promise<boolean> {
  const snapshot = await db
    .select({
      id: schema.sessionSnapshots.id,
      homeR2Key: schema.sessionSnapshots.homeR2Key,
      wipR2Key: schema.sessionSnapshots.wipR2Key,
      manifestR2Key: schema.sessionSnapshots.manifestR2Key,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!snapshot) return false;
  const keys = [snapshot.homeR2Key, snapshot.wipR2Key, snapshot.manifestR2Key].filter(
    (key): key is string => Boolean(key)
  );
  if (keys.length > 0) await env.R2.delete(keys);
  await db.delete(schema.sessionSnapshots).where(eq(schema.sessionSnapshots.id, snapshot.id));
  return true;
}

export async function claimSessionSnapshotRecovery(
  db: Db,
  env: Env,
  input: { chatSessionId: string; userId: string; taskId: string; now?: Date }
): Promise<SessionSnapshotRecoveryClaim> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAttempts = parsePositiveInt(
    env.SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS,
    DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
  );
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'waking',
      recoveryTaskId: input.taskId,
      recoveryAttempts: sql`${schema.sessionSnapshots.recoveryAttempts} + 1`,
      recoveryError: null,
      recoveryClaimedAt: nowIso,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.userId, input.userId),
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none'),
        isNotNull(schema.sessionSnapshots.sleepingAt),
        gt(schema.sessionSnapshots.expiresAt, now.toISOString()),
        lt(schema.sessionSnapshots.recoveryAttempts, maxAttempts),
        or(
          isNull(schema.sessionSnapshots.recoveryStatus),
          eq(schema.sessionSnapshots.recoveryStatus, 'failed')
        )
      )
    );
  if ((result.meta.changes ?? 0) > 0) {
    return { status: 'claimed', taskId: input.taskId };
  }

  const [snapshot] = await db
    .select({
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      expiresAt: schema.sessionSnapshots.expiresAt,
      recoveryStatus: schema.sessionSnapshots.recoveryStatus,
      recoveryTaskId: schema.sessionSnapshots.recoveryTaskId,
      recoveryAttempts: schema.sessionSnapshots.recoveryAttempts,
      recoveryClaimedAt: schema.sessionSnapshots.recoveryClaimedAt,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.userId, input.userId)
      )
    )
    .limit(1);
  if (snapshot?.recoveryStatus === 'waking' && snapshot.recoveryTaskId) {
    const staleBefore = new Date(now.getTime() - sessionRecoveryClaimLeaseMs(env)).toISOString();
    const claimIsStale = !snapshot.recoveryClaimedAt || snapshot.recoveryClaimedAt <= staleBefore;
    if (!claimIsStale) return { status: 'waking', taskId: snapshot.recoveryTaskId };

    const recoveryTask = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, snapshot.recoveryTaskId))
      .get();
    if (
      recoveryTask &&
      ['queued', 'delegated', 'in_progress', 'awaiting_followup'].includes(recoveryTask.status)
    ) {
      await db
        .update(schema.sessionSnapshots)
        .set({ recoveryClaimedAt: nowIso, updatedAt: nowIso })
        .where(
          and(
            eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
            eq(schema.sessionSnapshots.recoveryStatus, 'waking'),
            eq(schema.sessionSnapshots.recoveryTaskId, snapshot.recoveryTaskId)
          )
        );
      return { status: 'waking', taskId: snapshot.recoveryTaskId };
    }
    if (snapshot.recoveryAttempts < maxAttempts) {
      const reclaimed = await db
        .update(schema.sessionSnapshots)
        .set({
          recoveryTaskId: input.taskId,
          recoveryAttempts: sql`${schema.sessionSnapshots.recoveryAttempts} + 1`,
          recoveryClaimedAt: nowIso,
          recoveryError: null,
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
            eq(schema.sessionSnapshots.recoveryStatus, 'waking'),
            eq(schema.sessionSnapshots.recoveryTaskId, snapshot.recoveryTaskId),
            or(
              isNull(schema.sessionSnapshots.recoveryClaimedAt),
              lte(schema.sessionSnapshots.recoveryClaimedAt, staleBefore)
            ),
            lt(schema.sessionSnapshots.recoveryAttempts, maxAttempts)
          )
        );
      if ((reclaimed.meta.changes ?? 0) > 0) {
        return { status: 'claimed', taskId: input.taskId };
      }
      const winner = await db
        .select({ taskId: schema.sessionSnapshots.recoveryTaskId })
        .from(schema.sessionSnapshots)
        .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
        .get();
      if (winner?.taskId) return { status: 'waking', taskId: winner.taskId };
    }
  }
  const reason = !snapshot
    ? 'snapshot_missing'
    : Date.parse(snapshot.expiresAt) <= now.getTime()
      ? 'snapshot_expired'
      : snapshot.status !== 'available' || snapshot.degradation !== 'none'
        ? 'snapshot_not_complete'
        : snapshot.recoveryAttempts >= maxAttempts
          ? 'recovery_attempts_exhausted'
          : 'snapshot_not_wakeable';
  return { status: 'unavailable', reason };
}

export async function recordSessionSnapshotRecoveryWorkspace(
  db: Db,
  chatSessionId: string,
  taskId: string,
  workspaceId: string
): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({ recoveryWorkspaceId: workspaceId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.recoveryTaskId, taskId),
        inArray(schema.sessionSnapshots.recoveryStatus, ['waking', 'restored'])
      )
    );
}

export async function completeSessionSnapshotRecovery(
  db: Db,
  chatSessionId: string,
  taskId: string,
  workspaceId: string
): Promise<boolean> {
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'restored',
      recoveryWorkspaceId: workspaceId,
      recoveryError: null,
      recoveryClaimedAt: null,
      sleepStatus: null,
      sleepAfter: null,
      sleepAttempts: 0,
      sleepError: null,
      sleepingAt: null,
      restoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.recoveryTaskId, taskId),
        inArray(schema.sessionSnapshots.recoveryStatus, ['waking', 'restored'])
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

/** Record the in-place Cloudflare Container wake after its DO restored the runtime. */
export async function markSessionSnapshotAwakeInPlace(
  env: Env,
  chatSessionId: string,
  taskId: string,
  workspaceId: string
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const now = new Date().toISOString();
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepingAt: null,
      recoveryStatus: 'restored',
      recoveryTaskId: taskId,
      recoveryWorkspaceId: workspaceId,
      recoveryError: null,
      recoveryClaimedAt: null,
      sleepStatus: null,
      sleepAfter: null,
      sleepAttempts: 0,
      sleepError: null,
      restoredAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none')
      )
    );
}

export async function failSessionSnapshotRecovery(
  db: Db,
  env: Env,
  chatSessionId: string,
  taskId: string,
  error: string
): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({
      recoveryStatus: 'failed',
      recoveryError: sessionLifecycleError(env, error),
      recoveryClaimedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.recoveryTaskId, taskId),
        eq(schema.sessionSnapshots.recoveryStatus, 'waking')
      )
    );
}

export async function completeSessionSnapshot(
  db: Db,
  env: Env,
  input: CompleteSessionSnapshotInput
): Promise<void> {
  if (
    (input.artifactSizes.homeBytes != null) !== Boolean(input.artifactSha256?.homeSha256) ||
    (input.artifactSizes.wipBytes != null) !== Boolean(input.artifactSha256?.wipSha256)
  ) {
    throw new Error('Snapshot artifact hashes must match the captured artifacts');
  }
  const current = await db
    .select({
      captureGeneration: schema.sessionSnapshots.captureGeneration,
      homeR2Key: schema.sessionSnapshots.homeR2Key,
      wipR2Key: schema.sessionSnapshots.wipR2Key,
      manifestR2Key: schema.sessionSnapshots.manifestR2Key,
    })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId))
    .get();
  const captureGeneration = input.captureGeneration ?? current?.captureGeneration;
  if (!captureGeneration || captureGeneration !== current?.captureGeneration) {
    throw new Error('Snapshot capture generation is no longer current');
  }
  const homeR2Key =
    input.artifactSizes.homeBytes == null
      ? null
      : buildSessionSnapshotR2Key(env, input.chatSessionId, captureGeneration, 'home');
  const wipR2Key =
    input.artifactSizes.wipBytes == null
      ? null
      : buildSessionSnapshotR2Key(env, input.chatSessionId, captureGeneration, 'wip');
  const manifestR2Key = buildSessionSnapshotR2Key(
    env,
    input.chatSessionId,
    captureGeneration,
    'manifest'
  );
  const manifestJson = JSON.stringify(input.manifest);
  const completedAt = new Date();
  await env.R2.put(manifestR2Key, manifestJson, {
    httpMetadata: { contentType: 'application/json' },
  });

  const completed = await db
    .update(schema.sessionSnapshots)
    .set({
      agentSessionId: input.agentSessionId,
      runtime: input.runtime,
      status: input.status,
      degradation: input.degradation,
      homeR2Key,
      wipR2Key,
      manifestR2Key,
      snapshotGeneration: captureGeneration,
      captureGeneration: null,
      homeSha256: input.artifactSha256?.homeSha256 ?? null,
      wipSha256: input.artifactSha256?.wipSha256 ?? null,
      baseCommit: input.baseCommit,
      manifestJson,
      expiresAt: snapshotExpiry(completedAt, getSessionSnapshotConfig(env).ttlDays),
      updatedAt: completedAt.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId),
        eq(schema.sessionSnapshots.captureGeneration, captureGeneration)
      )
    );
  if (!(completed.meta.changes ?? 0)) {
    throw new Error('Snapshot completion lost its capture-generation claim');
  }

  const oldKeys = [current?.homeR2Key, current?.wipR2Key, current?.manifestR2Key].filter(
    (key): key is string =>
      Boolean(key) && key !== homeR2Key && key !== wipR2Key && key !== manifestR2Key
  );
  if (oldKeys.length > 0) {
    await env.R2.delete(oldKeys).catch(() => undefined);
  }

  if (input.status === 'available' && input.degradation === 'none') {
    await scheduleSessionSnapshotSleep(db, env, input.chatSessionId);
  }
}

export async function getRestorableSessionSnapshot(
  db: Db,
  chatSessionId: string,
  now = new Date()
): Promise<schema.SessionSnapshot | null> {
  const rows = await db
    .select()
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .limit(1);
  const snapshot = rows[0];
  if (!snapshot) return null;
  if (Date.parse(snapshot.expiresAt) <= now.getTime()) {
    return { ...snapshot, status: 'expired' };
  }
  if (snapshot.status !== 'available' && snapshot.status !== 'degraded') {
    return null;
  }
  return snapshot;
}

export async function recordSessionSnapshotRestoreResult(
  db: Db,
  input: {
    chatSessionId: string;
    status: string;
    message: string | null;
  }
): Promise<void> {
  await db
    .update(schema.sessionSnapshots)
    .set({
      restoreStatus: input.status,
      restoreMessage: input.message,
      restoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.sessionSnapshots.chatSessionId, input.chatSessionId));
}
