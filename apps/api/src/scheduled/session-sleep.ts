import { and, eq, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  noteFailedTaskPreservationCapture,
  releaseExhaustedFailedTaskPreservation,
} from '../services/failed-task-preservation';
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
 * After a slept attempt, surface an incomplete snapshot; after a failed one, tear
 * the runtime down once the persisted row has no retry left (`.claude/rules/47`).
 * Both helpers no-op for any other task, and never throw into the sweep.
 */
async function settleFailedTaskPreservation(
  env: Env,
  chatSessionId: string,
  outcome: 'slept' | 'failed'
): Promise<void> {
  const settle =
    outcome === 'slept'
      ? noteFailedTaskPreservationCapture
      : releaseExhaustedFailedTaskPreservation;
  await settle(env, { chatSessionId }).catch((error: unknown) => {
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
    await settleFailedTaskPreservation(env, candidate.chatSessionId, 'slept');
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
    await settleFailedTaskPreservation(env, candidate.chatSessionId, 'failed');
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
  const maxAttempts = parsePositiveInt(
    env.SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
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

  for (const candidate of candidates) {
    if (Date.now() - startedAt >= wallBudgetMs) {
      stats.budgetExhausted = true;
      break;
    }
    let claimId: string;
    try {
      if (!candidate.workspaceId) {
        if (await terminalizeMissingSleepSource(db, candidate, now)) stats.exhausted++;
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
        await db
          .update(schema.sessionSnapshots)
          .set({
            sleepStatus: 'failed',
            sleepAfter: null,
            sleepError: candidate.workspaceId
              ? 'Automatic sleep retry budget exhausted'
              : 'Snapshot has no source workspace',
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.sessionSnapshots.id, candidate.snapshotId));
        stats.exhausted++;
        const release = settleFailedTaskPreservation(env, candidate.chatSessionId, 'failed');
        if (context) context.waitUntil(release);
        else await release;
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
            if (await terminalizeMissingSleepSource(db, candidate, now)) stats.exhausted++;
          } else {
            stats.deferred++;
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
