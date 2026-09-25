import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { noteFailedTaskPreservationCapture } from '../services/failed-task-preservation';
import {
  releaseExhaustedFailedTaskPreservation,
  releaseStalledFailedTaskPreservation,
} from '../services/failed-task-preservation-release';
import {
  checkAutomaticSessionSleepEligibility,
  sleepWorkspaceSession,
} from '../services/session-sleep';
import {
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS,
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  deferSessionSnapshotSleepBeforeClaim,
  deferSessionSnapshotStopping,
  failSessionSnapshotSleepBeforeTeardown,
  sessionLifecycleError,
} from '../services/session-snapshots';
import { sessionSleepMaxAttempts } from '../services/sleep-preserved-task-status';
import { reconcileUnscheduledSessionSleeps } from './session-sleep-intent-reconciliation';
import { terminalizeMissingSleepSource } from './session-sleep-terminal';

export const DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE = 10;
export const DEFAULT_SESSION_SLEEP_SWEEP_WALL_BUDGET_MS = 20_000;
export { TERMINAL_SESSION_SLEEP_STATUS } from './session-sleep-terminal';
export { DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS, DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS };

export interface SessionSleepSweepStats {
  selected: number;
  reconciled: number;
  claimed: number;
  dispatched: number;
  slept: number;
  deferred: number;
  failed: number;
  exhausted: number;
  budgetExhausted: boolean;
}

export interface SessionSleepSweepContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A failed task's sleep is its work preservation (`failed-task-preservation.ts`).
 * After a slept attempt, surface an incomplete snapshot; after a failed or given-up
 * one, tear the runtime down once the sleep has no retry left; after a deferral,
 * tear it down once the claimer can no longer take it or the failure has waited
 * too long (`.claude/rules/47`). Each no-ops for any other task, and never throws
 * into the sweep.
 */
async function settleFailedTaskPreservation(
  env: Env,
  candidate: { chatSessionId: string; workspaceId: string | null },
  outcome: 'slept' | 'failed' | 'deferred'
): Promise<void> {
  const { chatSessionId, workspaceId } = candidate;
  const settled =
    outcome === 'slept'
      ? noteFailedTaskPreservationCapture(env, { chatSessionId })
      : outcome === 'failed'
        ? releaseExhaustedFailedTaskPreservation(env, { chatSessionId })
        : workspaceId
          ? releaseStalledFailedTaskPreservation(env, { chatSessionId, workspaceId })
          : Promise.resolve(false);
  await settled.catch((error: unknown) => {
    log.warn('session_sleep_sweep.failed_task_preservation_settle_failed', {
      chatSessionId,
      outcome,
      error: sessionLifecycleError(env, error),
    });
  });
}

async function sleepClaimedSession(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  candidate: {
    snapshotId: string;
    workspaceId: string;
    userId: string;
    chatSessionId: string;
    sleepAttempts: number;
  },
  claimId: string,
  maxAttempts: number
): Promise<{ status: 'slept' | 'failed'; exhausted: boolean }> {
  try {
    await sleepWorkspaceSession(env, {
      workspaceId: candidate.workspaceId,
      userId: candidate.userId,
      reason: 'Idle timeout elapsed',
      sleepClaimId: claimId,
    });
    await settleFailedTaskPreservation(env, candidate, 'slept');
    return { status: 'slept', exhausted: false };
  } catch (error) {
    const attempts = candidate.sleepAttempts + 1;
    const exhausted = attempts >= maxAttempts;
    const lifecycleError = sessionLifecycleError(env, error);
    await failSessionSnapshotSleepBeforeTeardown(
      db,
      env,
      candidate.chatSessionId,
      claimId,
      lifecycleError
    ).catch((persistenceError) => {
      log.error('session_sleep_sweep.failure_persistence_failed', {
        snapshotId: candidate.snapshotId,
        workspaceId: candidate.workspaceId,
        chatSessionId: candidate.chatSessionId,
        error: sessionLifecycleError(env, persistenceError),
      });
    });
    log.warn('session_sleep_sweep.failed', {
      snapshotId: candidate.snapshotId,
      workspaceId: candidate.workspaceId,
      chatSessionId: candidate.chatSessionId,
      attempts,
      exhausted,
      error: lifecycleError,
    });
    await settleFailedTaskPreservation(env, candidate, 'failed');
    return { status: 'failed', exhausted };
  }
}

/**
 * Claim and sleep a bounded page of idle sessions. The claim is a D1 CAS so
 * overlapping cron invocations cannot tear down the same runtime twice.
 */
export async function runSessionSleepSweep(
  env: Env,
  now = new Date(),
  context?: SessionSleepSweepContext
): Promise<SessionSleepSweepStats> {
  const startedAt = Date.now();
  const db = drizzle(env.DATABASE, { schema });
  const batchSize = parsePositiveInt(
    env.SESSION_SLEEP_SWEEP_BATCH_SIZE,
    DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE
  );
  // The same resolver the reapers' "gave up" predicate reads, so the two agree.
  const maxAttempts = sessionSleepMaxAttempts(env);
  const wallBudgetMs = parsePositiveInt(
    env.SESSION_SLEEP_SWEEP_WALL_BUDGET_MS,
    DEFAULT_SESSION_SLEEP_SWEEP_WALL_BUDGET_MS
  );
  const stats: SessionSleepSweepStats = {
    selected: 0,
    reconciled: 0,
    claimed: 0,
    dispatched: 0,
    slept: 0,
    deferred: 0,
    failed: 0,
    exhausted: 0,
    budgetExhausted: false,
  };

  stats.reconciled = await reconcileUnscheduledSessionSleeps(env, db, batchSize, now);

  const candidates = await db
    .select({
      snapshotId: schema.sessionSnapshots.id,
      workspaceId: schema.sessionSnapshots.workspaceId,
      userId: schema.sessionSnapshots.userId,
      chatSessionId: schema.sessionSnapshots.chatSessionId,
      sleepAttempts: schema.sessionSnapshots.sleepAttempts,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepAfter: schema.sessionSnapshots.sleepAfter,
      sleepClaimId: schema.sessionSnapshots.sleepClaimId,
      sleepClaimedAt: schema.sessionSnapshots.sleepClaimedAt,
      updatedAt: schema.sessionSnapshots.updatedAt,
      status: schema.sessionSnapshots.status,
      captureGeneration: schema.sessionSnapshots.captureGeneration,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        inArray(schema.sessionSnapshots.status, ['pending', 'available', 'degraded', 'failed']),
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          and(
            inArray(schema.sessionSnapshots.sleepStatus, ['scheduled', 'failed']),
            lte(schema.sessionSnapshots.sleepAfter, now.toISOString())
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'failed'),
            isNull(schema.sessionSnapshots.sleepAfter),
            lt(schema.sessionSnapshots.sleepAttempts, maxAttempts)
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'failed'),
            or(
              isNull(schema.sessionSnapshots.sleepAfter),
              lte(schema.sessionSnapshots.sleepAfter, now.toISOString())
            ),
            or(
              eq(schema.sessionSnapshots.status, 'degraded'),
              isNotNull(schema.sessionSnapshots.captureGeneration)
            )
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'preparing'),
            or(
              isNull(schema.sessionSnapshots.sleepClaimedAt),
              lte(
                schema.sessionSnapshots.sleepClaimedAt,
                new Date(
                  now.getTime() -
                    parsePositiveInt(
                      (env as Env & { SESSION_SLEEP_CLAIM_LEASE_MS?: string })
                        .SESSION_SLEEP_CLAIM_LEASE_MS,
                      DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
                    )
                ).toISOString()
              )
            )
          ),
          and(
            eq(schema.sessionSnapshots.sleepStatus, 'stopping'),
            or(
              lte(schema.sessionSnapshots.sleepAfter, now.toISOString()),
              isNull(schema.sessionSnapshots.sleepClaimedAt),
              lte(
                schema.sessionSnapshots.sleepClaimedAt,
                new Date(
                  now.getTime() -
                    parsePositiveInt(
                      (env as Env & { SESSION_SLEEP_CLAIM_LEASE_MS?: string })
                        .SESSION_SLEEP_CLAIM_LEASE_MS,
                      DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
                    )
                ).toISOString()
              )
            )
          )
        )
      )
    )
    .orderBy(schema.sessionSnapshots.sleepAfter, schema.sessionSnapshots.id)
    .limit(batchSize);
  stats.selected = candidates.length;

  // Releases do network I/O (chat notice, teardown): keep them off the sweep's
  // critical path whenever the caller can hold the work open.
  const settleInBackground = async (
    candidate: (typeof candidates)[number],
    outcome: 'failed' | 'deferred'
  ): Promise<void> => {
    const settled = settleFailedTaskPreservation(env, candidate, outcome);
    if (context) context.waitUntil(settled);
    else await settled;
  };

  for (const candidate of candidates) {
    if (Date.now() - startedAt >= wallBudgetMs) {
      stats.budgetExhausted = true;
      break;
    }
    let claimId: string;
    try {
      if (!candidate.workspaceId) {
        if (await terminalizeMissingSleepSource(db, candidate, now)) {
          stats.exhausted++;
          await settleInBackground(candidate, 'failed');
        }
        continue;
      }
      if (
        candidate.sleepStatus !== 'stopping' &&
        candidate.sleepAttempts >= maxAttempts &&
        !(
          candidate.sleepStatus === 'failed' &&
          (candidate.sleepAfter === null || candidate.sleepAfter <= now.toISOString()) &&
          (candidate.status === 'degraded' || candidate.captureGeneration)
        )
      ) {
        const exhaustion = await db
          .update(schema.sessionSnapshots)
          .set({
            sleepStatus: 'failed',
            sleepAfter: null,
            sleepError: candidate.workspaceId
              ? 'Automatic sleep retry budget exhausted'
              : 'Snapshot has no source workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(schema.sessionSnapshots.id, candidate.snapshotId),
              // Only the row this sweep selected: a sleep episode restarted since
              // (a new failure resets the budget), or a stale claim whose owner has
              // since moved it on (`preparing` -> `stopping`), is left alone.
              eq(schema.sessionSnapshots.sleepAttempts, candidate.sleepAttempts),
              sql`${schema.sessionSnapshots.sleepStatus} IS ${candidate.sleepStatus}`,
              sql`${schema.sessionSnapshots.sleepClaimId} IS ${candidate.sleepClaimId}`,
              isNull(schema.sessionSnapshots.sleepingAt)
            )
          );
        if ((exhaustion.meta.changes ?? 0) > 0) {
          stats.exhausted++;
          await settleInBackground(candidate, 'failed');
        }
        continue;
      }
      claimId = crypto.randomUUID();
      if (candidate.sleepStatus !== 'stopping') {
        const eligibility = await checkAutomaticSessionSleepEligibility(env, {
          workspaceId: candidate.workspaceId,
          userId: candidate.userId,
          sleepStatus: candidate.sleepStatus,
          sleepClaimId: candidate.sleepClaimId,
        });
        if (!eligibility.eligible) {
          if (eligibility.reason === 'workspace_metadata_missing') {
            if (await terminalizeMissingSleepSource(db, candidate, now)) {
              stats.exhausted++;
              await settleInBackground(candidate, 'failed');
            }
          } else {
            stats.deferred++;
            await settleInBackground(candidate, 'deferred');
          }
          continue;
        }
      }
      const claim = await claimSessionSnapshotSleep(db, env, {
        chatSessionId: candidate.chatSessionId,
        claimId,
        now,
      });
      if (claim.status !== 'claimed') continue;
      stats.claimed++;
    } catch (error) {
      stats.failed++;
      const lifecycleError = sessionLifecycleError(env, error);
      const deferral =
        candidate.sleepStatus === 'stopping'
          ? deferSessionSnapshotStopping(
              db,
              env,
              candidate.chatSessionId,
              candidate.sleepClaimId,
              lifecycleError,
              now
            )
          : deferSessionSnapshotSleepBeforeClaim(
              db,
              env,
              candidate.chatSessionId,
              lifecycleError,
              undefined,
              now,
              candidate.sleepStatus === 'preparing'
                ? { expectedPreparingClaimId: candidate.sleepClaimId }
                : undefined
            );
      await deferral.catch((persistenceError) => {
        log.error('session_sleep_sweep.candidate_deferral_failed', {
          snapshotId: candidate.snapshotId,
          workspaceId: candidate.workspaceId,
          chatSessionId: candidate.chatSessionId,
          error: sessionLifecycleError(env, persistenceError),
        });
      });
      log.warn('session_sleep_sweep.candidate_failed', {
        snapshotId: candidate.snapshotId,
        workspaceId: candidate.workspaceId,
        chatSessionId: candidate.chatSessionId,
        error: lifecycleError,
      });
      // Deferred without spending an attempt, like any deferral: a candidate that
      // throws every sweep must still reach the failed-task escapes.
      if (candidate.sleepStatus !== 'stopping') {
        await settleInBackground(candidate, 'deferred');
      }
      continue;
    }

    const operation = sleepClaimedSession(
      env,
      db,
      {
        snapshotId: candidate.snapshotId,
        workspaceId: candidate.workspaceId,
        userId: candidate.userId,
        chatSessionId: candidate.chatSessionId,
        sleepAttempts: candidate.sleepAttempts,
      },
      claimId,
      maxAttempts
    );
    if (context) {
      stats.dispatched++;
      context.waitUntil(
        operation.then((result) => {
          log.info('session_sleep_sweep.dispatched_completed', {
            snapshotId: candidate.snapshotId,
            workspaceId: candidate.workspaceId,
            status: result.status,
            exhausted: result.exhausted,
          });
        })
      );
      continue;
    }

    const result = await operation;
    if (result.status === 'slept') {
      stats.slept++;
    } else {
      stats.failed++;
      if (result.exhausted) stats.exhausted++;
    }
  }

  return stats;
}
