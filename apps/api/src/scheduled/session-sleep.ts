import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  releaseExhaustedFailedTaskPreservation,
  releaseStalledFailedTaskPreservation,
} from '../services/failed-task-preservation-release';
import {
  checkAutomaticSessionSleepEligibility,
  sleepWorkspaceSession,
} from '../services/session-sleep';
import {
  sessionSleepEpisodeConfig,
  sessionSleepEpisodePhase,
  sessionSleepEpisodeTrigger,
} from '../services/session-sleep-episode';
import {
  endSessionSleepEpisodeBlocked,
  runSessionSleepFallback,
  type SessionSleepFallbackOutcome,
} from '../services/session-sleep-fallback';
import {
  isDeadSleepIntentWorkspace,
  retireDeadWorkspaceSleepIntent,
} from '../services/session-sleep-fallback-state';
import {
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS,
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  deferSessionSnapshotSleepBeforeClaim,
  deferSessionSnapshotStopping,
  failSessionSnapshotSleepBeforeTeardown,
  sessionLifecycleError,
} from '../services/session-snapshots';
import { sessionSleepMaxAttempts } from '../services/sleep-preserved-task-status';
import { selectSweepCandidates } from './session-sleep-candidates';
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
  /** Sleep episodes that ended this sweep: blocked, or a missing source retired. */
  exhausted: number;
  /** Bounded fallback attempts started (`runSessionSleepFallback`). */
  fallbacks: number;
  /** Episodes that ended blocked without a recovery point. */
  blocked: number;
  /** Intents retired because their workspace is gone. */
  retired: number;
  budgetExhausted: boolean;
}

export interface SessionSleepSweepContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A failed task's sleep is its work preservation (`failed-task-preservation.ts`).
 * After a failed or given-up attempt, tear the runtime down once the sleep has no
 * retry left; after a deferral, tear it down once the claimer can no longer take
 * it or the episode has waited too long (`.claude/rules/47`). An incomplete
 * capture is surfaced where every sleep finalizes
 * (`finalizeSessionSnapshotSleeping`). Each no-ops for any other task, and never
 * throws into the sweep.
 */
async function settleFailedTaskPreservation(
  env: Env,
  candidate: { chatSessionId: string; workspaceId: string | null },
  outcome: 'failed' | 'deferred'
): Promise<void> {
  const { chatSessionId, workspaceId } = candidate;
  const settled =
    outcome === 'failed'
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
  candidate: SweepCandidate & { workspaceId: string },
  claimId: string,
  now: Date
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
    const failures = (candidate.sleepEpisodeFailures ?? 0) + 1;
    // Whether this failure ends the full-snapshot phase of the bounded episode; the
    // next sweep then falls back or ends it blocked (`session-sleep-episode.ts`).
    const exhausted =
      sessionSleepEpisodePhase(
        { ...candidate, sleepEpisodeFailures: failures },
        now,
        sessionSleepEpisodeConfig(env)
      ) !== 'full';
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
      attempts: candidate.sleepAttempts + 1,
      episodeFailures: failures,
      episodeStartedAt: candidate.sleepEpisodeStartedAt,
      exhausted,
      error: lifecycleError,
    });
    await settleFailedTaskPreservation(env, candidate, 'failed');
    return { status: 'failed', exhausted };
  }
}

type SweepCandidate = Awaited<ReturnType<typeof selectSweepCandidates>>[number];

/**
 * Claim and sleep a bounded page of idle sessions. The claim is a D1 CAS so
 * overlapping cron invocations cannot tear down the same runtime twice. Each
 * candidate's bounded sleep-failure episode (`session-sleep-episode.ts`) decides
 * whether it gets a full-snapshot attempt, the transcript-and-Git fallback
 * (`runSessionSleepFallback`), or ends blocked.
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
  const episodeConfig = sessionSleepEpisodeConfig(env);
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
    fallbacks: 0,
    blocked: 0,
    retired: 0,
    budgetExhausted: false,
  };

  stats.reconciled = await reconcileUnscheduledSessionSleeps(env, db, batchSize, now);

  const candidates = await selectSweepCandidates(env, db, now, batchSize, maxAttempts);
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
    const workspaceId = candidate.workspaceId;
    let claimId: string;
    try {
      if (!workspaceId) {
        if (await terminalizeMissingSleepSource(db, candidate, now)) {
          stats.exhausted++;
          await settleInBackground(candidate, 'failed');
        }
        continue;
      }
      if (
        candidate.workspaceStatus &&
        isDeadSleepIntentWorkspace(candidate.sleepStatus, candidate.workspaceStatus)
      ) {
        const retired = await retireDeadWorkspaceSleepIntent(db, {
          snapshotId: candidate.snapshotId,
          workspaceId,
          workspaceStatus: candidate.workspaceStatus,
          sleepStatus: candidate.sleepStatus,
          sleepAttempts: candidate.sleepAttempts,
          now,
        });
        if (retired) {
          stats.retired++;
          log.info('session_sleep_sweep.dead_workspace_intent_retired', {
            snapshotId: candidate.snapshotId,
            workspaceId,
            chatSessionId: candidate.chatSessionId,
            workspaceStatus: candidate.workspaceStatus,
            sleepStatus: candidate.sleepStatus,
          });
          // A failed task whose workspace is gone still gets its release and notice.
          await settleInBackground(candidate, 'deferred');
        }
        continue;
      }
      if (candidate.sleepStatus !== 'stopping') {
        const phase = sessionSleepEpisodePhase(candidate, now, episodeConfig);
        if (phase === 'blocked') {
          const blocked = await endSessionSleepEpisodeBlocked(env, {
            chatSessionId: candidate.chatSessionId,
            reason: 'retry_ceiling',
            trigger: 'retry_ceiling',
            lastError: candidate.sleepError,
            expected: {
              kind: 'observed',
              sleepStatus: candidate.sleepStatus,
              sleepEpisodeFailures: candidate.sleepEpisodeFailures ?? 0,
            },
            now,
          });
          if (blocked) {
            stats.blocked++;
            stats.exhausted++;
            await settleInBackground(candidate, 'failed');
          }
          continue;
        }
        const eligibility = await checkAutomaticSessionSleepEligibility(env, {
          workspaceId,
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
        if (phase === 'fallback') {
          stats.fallbacks++;
          const fallback = runSessionSleepFallback(env, {
            workspaceId,
            userId: candidate.userId,
            chatSessionId: candidate.chatSessionId,
            claimId: crypto.randomUUID(),
            trigger: sessionSleepEpisodeTrigger(candidate, now, episodeConfig) ?? 'attempt_budget',
            lastError: candidate.sleepError,
            now,
          })
            .catch((error: unknown): SessionSleepFallbackOutcome => {
              log.warn('session_sleep_sweep.fallback_failed', {
                snapshotId: candidate.snapshotId,
                workspaceId,
                chatSessionId: candidate.chatSessionId,
                error: sessionLifecycleError(env, error),
              });
              return 'retry';
            })
            .then(async (outcome) => {
              log.info('session_sleep_sweep.fallback_completed', {
                snapshotId: candidate.snapshotId,
                workspaceId,
                chatSessionId: candidate.chatSessionId,
                outcome,
              });
              if (outcome === 'blocked')
                await settleFailedTaskPreservation(env, candidate, 'failed');
              return outcome;
            });
          if (context) {
            stats.dispatched++;
            context.waitUntil(fallback);
          } else {
            const outcome = await fallback;
            if (outcome === 'slept') stats.slept++;
            else if (outcome === 'blocked') {
              stats.blocked++;
              stats.exhausted++;
            } else if (outcome === 'retry') stats.failed++;
            else if (outcome === 'deferred') stats.deferred++;
          }
          continue;
        }
      }
      claimId = crypto.randomUUID();
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
          workspaceId,
          chatSessionId: candidate.chatSessionId,
          error: sessionLifecycleError(env, persistenceError),
        });
      });
      log.warn('session_sleep_sweep.candidate_failed', {
        snapshotId: candidate.snapshotId,
        workspaceId,
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

    const operation = sleepClaimedSession(env, db, { ...candidate, workspaceId }, claimId, now);
    if (context) {
      stats.dispatched++;
      context.waitUntil(
        operation.then((result) => {
          log.info('session_sleep_sweep.dispatched_completed', {
            snapshotId: candidate.snapshotId,
            workspaceId,
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
