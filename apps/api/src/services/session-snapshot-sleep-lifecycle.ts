import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { DEFAULT_CF_CONTAINER_SLEEP_AFTER } from '../durable-objects/vm-agent-container';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
  getSessionSnapshotConfig,
  sessionLifecycleError,
  type SessionSnapshotSleepClaim,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SnapshotLeaseEnv = Env & {
  SESSION_SLEEP_CLAIM_LEASE_MS?: string;
  SESSION_SLEEP_RETRY_DELAY_MS?: string;
  SESSION_SLEEP_MAX_ATTEMPTS?: string;
  SESSION_LIFECYCLE_ERROR_MAX_LENGTH?: string;
};

function snapshotExpiry(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

function parseContainerDurationMs(configured: string): number | null {
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  const parts = configured.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g);
  let consumed = '';
  let total = 0;
  for (const part of parts) {
    const amount = part[1];
    const unit = part[2];
    if (!amount || !unit) continue;
    consumed += part[0];
    total += Number(amount) * (units[unit] ?? 0);
  }
  return consumed === configured && Number.isFinite(total) && total > 0 ? Math.floor(total) : null;
}

function containerSleepAfterMs(env: Env): number {
  const configured =
    env.CF_CONTAINER_SLEEP_AFTER || env.SANDBOX_SLEEP_AFTER || DEFAULT_CF_CONTAINER_SLEEP_AFTER;
  return (
    parseContainerDurationMs(configured) ??
    (parseContainerDurationMs(DEFAULT_CF_CONTAINER_SLEEP_AFTER) as number)
  );
}

function sessionSleepClaimLeaseMs(env: Env): number {
  return parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_CLAIM_LEASE_MS,
    DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
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
  const maxAttempts = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const dueCondition = input.force
    ? or(
        isNull(schema.sessionSnapshots.sleepStatus),
        inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed'])
      )
    : or(
        and(
          inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed']),
          lte(schema.sessionSnapshots.sleepAfter, nowIso)
        ),
        and(
          eq(schema.sessionSnapshots.sleepStatus, 'failed'),
          isNull(schema.sessionSnapshots.sleepAfter),
          lt(schema.sessionSnapshots.sleepAttempts, maxAttempts)
        )
      );
  // A final verified snapshot is produced inside sleepWorkspaceSession. Pending,
  // degraded, and failed captures must therefore remain claimable; requiring an
  // already-perfect snapshot here strands precisely the sessions the final
  // capture is meant to repair. Explicit sleep may also replace expired state.
  const claimableSnapshotCondition = inArray(
    schema.sessionSnapshots.status,
    input.force
      ? ['pending', 'available', 'degraded', 'failed', 'expired']
      : ['pending', 'available', 'degraded', 'failed']
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
        claimableSnapshotCondition,
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
  claimId: string | null,
  error: string,
  now = new Date()
): Promise<boolean> {
  const retryDelayMs = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_RETRY_DELAY_MS,
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
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
        claimId === null
          ? isNull(schema.sessionSnapshots.sleepClaimId)
          : eq(schema.sessionSnapshots.sleepClaimId, claimId)
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
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
  );
  const maxAttempts = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
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

/**
 * Defer an automatic sleep before a claim is consumed. Activity/idle
 * preconditions are expected to change and must not spend the bounded budget
 * reserved for actual snapshot or teardown failures.
 */
export async function deferSessionSnapshotSleepBeforeClaim(
  db: Db,
  env: Env,
  chatSessionId: string,
  error: string,
  retryAt?: Date,
  now = new Date(),
  options: { expectedPreparingClaimId?: string | null } = {}
): Promise<boolean> {
  const retryDelayMs = parsePositiveInt(
    (env as SnapshotLeaseEnv).SESSION_SLEEP_RETRY_DELAY_MS,
    DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
  );
  const dueAt = retryAt ?? new Date(now.getTime() + retryDelayMs);
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'scheduled',
      sleepAfter: dueAt.toISOString(),
      sleepError: sessionLifecycleError(env, error),
      sleepClaimId: null,
      sleepClaimedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        or(
          inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed']),
          ...(options.expectedPreparingClaimId !== undefined
            ? [
                and(
                  eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
                  options.expectedPreparingClaimId === null
                    ? isNull(schema.sessionSnapshots.sleepClaimId)
                    : eq(schema.sessionSnapshots.sleepClaimId, options.expectedPreparingClaimId)
                ),
              ]
            : [])
        ),
        isNull(schema.sessionSnapshots.sleepingAt)
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
  now = new Date(),
  options: {
    sleepAfterMs?: number;
    allowIncomplete?: boolean;
    resetAttempts?: boolean;
    runtime?: string;
  } = {}
): Promise<void> {
  const sleepAfterMs =
    options.sleepAfterMs === undefined
      ? options.runtime === 'cf-container'
        ? containerSleepAfterMs(env)
        : parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS)
      : Math.max(0, options.sleepAfterMs);
  const requestedSleepAfter = new Date(now.getTime() + sleepAfterMs).toISOString();
  const eligibleSnapshot = options.allowIncomplete
    ? inArray(schema.sessionSnapshots.status, ['pending', 'available', 'degraded', 'failed'])
    : and(
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none')
      );
  const resetAttempts = options.resetAttempts ?? !options.allowIncomplete;
  await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'scheduled',
      // Completion of a later checkpoint must not postpone an earlier terminal
      // sleep intent that was queued while the final prompt was still running.
      sleepAfter: sql`CASE
        WHEN ${schema.sessionSnapshots.sleepAfter} IS NOT NULL
         AND ${schema.sessionSnapshots.sleepAfter} < ${requestedSleepAfter}
        THEN ${schema.sessionSnapshots.sleepAfter}
        ELSE ${requestedSleepAfter}
      END`,
      ...(resetAttempts ? { sleepAttempts: 0 } : {}),
      sleepError: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eligibleSnapshot,
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
