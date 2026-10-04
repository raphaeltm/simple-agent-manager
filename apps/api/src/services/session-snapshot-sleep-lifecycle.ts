import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
  getSessionSnapshotConfig,
  sessionLifecycleError,
} from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

type SnapshotLeaseEnv = Env & {
  SESSION_SLEEP_RETRY_DELAY_MS?: string;
  SESSION_LIFECYCLE_ERROR_MAX_LENGTH?: string;
};

function snapshotExpiry(now: Date, ttlDays: number): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export async function beginSessionSnapshotStopping(
  db: Db,
  chatSessionId: string,
  claimId: string,
  expectedGeneration: string,
  now = new Date()
): Promise<boolean> {
  const nowIso = now.toISOString();
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepStatus: 'stopping',
      sleepAfter: null,
      sleepClaimedAt: nowIso,
      sleepStoppingSince: sql`COALESCE(${schema.sessionSnapshots.sleepStoppingSince}, ${nowIso})`,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
        eq(schema.sessionSnapshots.sleepClaimId, claimId),
        eq(schema.sessionSnapshots.snapshotGeneration, expectedGeneration),
        eq(schema.sessionSnapshots.status, 'available'),
        eq(schema.sessionSnapshots.degradation, 'none'),
        isNull(schema.sessionSnapshots.captureGeneration),
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

export { failSessionSnapshotSleepBeforeTeardown } from './session-snapshot-sleep-failure';

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
  now?: Date,
  expectedGeneration?: string
): Promise<boolean>;
export async function markSessionSnapshotSleeping(
  db: Db,
  envOrChatSessionId: Env | string,
  chatSessionIdOrNow?: string | Date,
  maybeNow = new Date(),
  expectedGeneration?: string
): Promise<boolean> {
  const env = typeof envOrChatSessionId === 'string' ? undefined : envOrChatSessionId;
  const chatSessionId =
    typeof envOrChatSessionId === 'string' ? envOrChatSessionId : String(chatSessionIdOrNow);
  const now = chatSessionIdOrNow instanceof Date ? chatSessionIdOrNow : maybeNow;
  return markSessionSnapshotSleepingWithConfig(
    db,
    env,
    chatSessionId,
    now,
    undefined,
    undefined,
    expectedGeneration
  );
}

async function markSessionSnapshotSleepingWithConfig(
  db: Db,
  env: Env | undefined,
  chatSessionId: string,
  now: Date,
  claimId?: string,
  sleepWarning?: string | null,
  expectedGeneration?: string,
  fallback = false
): Promise<boolean> {
  const ttlDays = env ? getSessionSnapshotConfig(env).ttlDays : DEFAULT_SESSION_SNAPSHOT_TTL_DAYS;
  const warning = sleepWarning && env ? sessionLifecycleError(env, sleepWarning) : null;
  const result = await db
    .update(schema.sessionSnapshots)
    .set({
      sleepingAt: now.toISOString(),
      expiresAt: snapshotExpiry(now, ttlDays),
      recoveryStatus: null,
      recoveryError: null,
      recoveryAttempts: 0,
      recoveryFailedAt: null,
      sleepStatus: 'sleeping',
      sleepAfter: null,
      sleepError: warning,
      sleepClaimId: null,
      sleepClaimedAt: null,
      // The sleep happened: the failure episode is over (`session-sleep-episode.ts`).
      // `sleep_fallback_json` stays, so the wake can tell what was not saved.
      sleepEpisodeStartedAt: null,
      sleepEpisodeFailures: 0,
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        ...(expectedGeneration
          ? [
              eq(schema.sessionSnapshots.snapshotGeneration, expectedGeneration),
              // A full sleep needs the complete generation it verified. A fallback sleep
              // releases compute with the restorable recovery point it recorded, which may
              // be degraded; the restorable pair below still applies to both.
              ...(fallback
                ? [isNotNull(schema.sessionSnapshots.sleepFallbackJson)]
                : [
                    eq(schema.sessionSnapshots.status, 'available'),
                    eq(schema.sessionSnapshots.degradation, 'none'),
                  ]),
              isNull(schema.sessionSnapshots.captureGeneration),
            ]
          : []),
        or(
          and(
            eq(schema.sessionSnapshots.status, 'available'),
            eq(schema.sessionSnapshots.degradation, 'none')
          ),
          and(
            eq(schema.sessionSnapshots.status, 'degraded'),
            ne(schema.sessionSnapshots.degradation, 'none')
          )
        ),
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
  now = new Date(),
  options: { sleepWarning?: string | null; expectedGeneration?: string; fallback?: boolean } = {}
): Promise<boolean> {
  const finalized = await markSessionSnapshotSleepingWithConfig(
    db,
    env,
    chatSessionId,
    now,
    claimId,
    options.sleepWarning,
    options.expectedGeneration,
    options.fallback ?? false
  );
  if (finalized) {
    // Every sleep finalizes here — the sleep sweep and an Instant container's own
    // idle sleep alike — so a failed task's incomplete capture is surfaced
    // whichever path slept it (`.claude/rules/61`). Best effort: never undoes the
    // sleep. Loaded lazily: that module queues sleeps through this one.
    const { noteFailedTaskPreservationCapture } = await import('./failed-task-preservation');
    await noteFailedTaskPreservationCapture(env, { chatSessionId }).catch((err: unknown) => {
      log.warn('session_sleep.failed_task_capture_note_failed', {
        chatSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return finalized;
}

export { cancelScheduledSessionSleep } from './session-snapshot-sleep-cancel';
export { claimSessionSnapshotSleep } from './session-snapshot-sleep-claim';
export { scheduleSessionSnapshotSleep } from './session-snapshot-sleep-schedule';
