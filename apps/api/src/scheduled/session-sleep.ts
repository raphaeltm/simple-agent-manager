import { and, eq, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  checkAutomaticSessionSleepEligibility,
  queueWorkspaceSessionSleep,
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

export const DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE = 10;
export const DEFAULT_SESSION_SLEEP_SWEEP_WALL_BUDGET_MS = 20_000;
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

async function reconcileUnscheduledSessionSleeps(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  batchSize: number,
  now: Date
): Promise<number> {
  // Bounded D1-only discovery. Each successful candidate receives a persisted
  // sleep deadline and leaves this selector; queueWorkspaceSessionSleep does no
  // VM-agent I/O. Runtime activity is checked later, immediately before claim.
  const candidates = await db
    .selectDistinct({
      workspaceId: schema.workspaces.id,
      userId: schema.workspaces.userId,
      chatSessionId: schema.workspaces.chatSessionId,
    })
    .from(schema.workspaces)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .innerJoin(
      schema.agentSessions,
      and(
        eq(schema.agentSessions.workspaceId, schema.workspaces.id),
        inArray(schema.agentSessions.status, ['running', 'recovery', 'sleeping'])
      )
    )
    .leftJoin(
      schema.sessionSnapshots,
      eq(schema.sessionSnapshots.chatSessionId, schema.workspaces.chatSessionId)
    )
    .where(
      and(
        inArray(schema.workspaces.status, ['running', 'recovery']),
        eq(schema.nodes.nodeRole, 'workspace'),
        eq(schema.nodes.runtime, 'vm'),
        isNotNull(schema.workspaces.projectId),
        isNotNull(schema.workspaces.chatSessionId),
        isNull(schema.sessionSnapshots.sleepingAt),
        isNull(schema.sessionSnapshots.sleepStatus)
      )
    )
    .orderBy(schema.workspaces.updatedAt, schema.workspaces.id)
    .limit(batchSize);

  let reconciled = 0;
  for (const candidate of candidates) {
    try {
      await queueWorkspaceSessionSleep(env, {
        workspaceId: candidate.workspaceId,
        userId: candidate.userId,
        reason: 'Scheduled sleep-intent reconciliation',
        // Eligibility derives the authoritative ProjectData idle deadline and
        // defers active/recent sessions. Queue immediately so an already-idle
        // workspace does not pay a second full idle interval after discovery.
        sleepAfterMs: 0,
      });
      reconciled++;
    } catch (error) {
      const retryDelayMs = parsePositiveInt(
        env.SESSION_SLEEP_RETRY_DELAY_MS,
        DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS
      );
      const retryAt = new Date(now.getTime() + retryDelayMs).toISOString();
      if (candidate.chatSessionId) {
        await db
          .update(schema.sessionSnapshots)
          .set({
            sleepStatus: 'scheduled',
            sleepAfter: retryAt,
            sleepError: sessionLifecycleError(env, error),
            sleepClaimId: null,
            sleepClaimedAt: null,
            updatedAt: now.toISOString(),
          })
          .where(
            and(
              eq(schema.sessionSnapshots.chatSessionId, candidate.chatSessionId),
              isNull(schema.sessionSnapshots.sleepStatus),
              isNull(schema.sessionSnapshots.sleepingAt)
            )
          )
          .catch(() => undefined);
      }
      // Candidate isolation is mandatory: one malformed or concurrently removed
      // workspace cannot suppress reconciliation for the rest of the bounded page.
      log.warn('session_sleep_sweep.reconcile_failed', {
        workspaceId: candidate.workspaceId,
        error: sessionLifecycleError(env, error),
      });
    }
  }
  return reconciled;
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
            isNull(schema.sessionSnapshots.sleepAfter),
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
      if (
        !candidate.workspaceId ||
        (candidate.sleepStatus !== 'stopping' &&
          candidate.sleepAttempts >= maxAttempts &&
          !(
            candidate.sleepStatus === 'failed' &&
            candidate.sleepAfter === null &&
            (candidate.status === 'degraded' || candidate.captureGeneration)
          ))
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
            await db
              .update(schema.sessionSnapshots)
              .set({
                sleepStatus: 'failed',
                sleepAfter: null,
                sleepError: 'Workspace metadata missing during automatic sleep',
                updatedAt: now.toISOString(),
              })
              .where(eq(schema.sessionSnapshots.id, candidate.snapshotId));
            stats.exhausted++;
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
