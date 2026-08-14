import { and, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
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
  failSessionSnapshotSleepBeforeTeardown,
  sessionLifecycleError,
} from '../services/session-snapshots';

export const DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE = 10;
export { DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS, DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS };

export interface SessionSleepSweepStats {
  selected: number;
  reconciled: number;
  claimed: number;
  slept: number;
  deferred: number;
  failed: number;
  exhausted: number;
}

async function reconcileUnscheduledSessionSleeps(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  batchSize: number
): Promise<number> {
  // Bounded D1-only discovery. Each successful candidate receives a persisted
  // sleep deadline and leaves this selector; queueWorkspaceSessionSleep does no
  // VM-agent I/O. Runtime activity is checked later, immediately before claim.
  const candidates = await db
    .selectDistinct({
      workspaceId: schema.workspaces.id,
      userId: schema.workspaces.userId,
      taskStatus: schema.tasks.status,
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
    .leftJoin(schema.tasks, eq(schema.tasks.chatSessionId, schema.workspaces.chatSessionId))
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
        ...(candidate.taskStatus === 'completed' ? { sleepAfterMs: 0 } : {}),
      });
      reconciled++;
    } catch (error) {
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

/**
 * Claim and sleep a bounded page of idle sessions. The claim is a D1 CAS so
 * overlapping cron invocations cannot tear down the same runtime twice.
 */
export async function runSessionSleepSweep(
  env: Env,
  now = new Date()
): Promise<SessionSleepSweepStats> {
  const db = drizzle(env.DATABASE, { schema });
  const batchSize = parsePositiveInt(
    env.SESSION_SLEEP_SWEEP_BATCH_SIZE,
    DEFAULT_SESSION_SLEEP_SWEEP_BATCH_SIZE
  );
  const maxAttempts = parsePositiveInt(
    env.SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const stats: SessionSleepSweepStats = {
    selected: 0,
    reconciled: 0,
    claimed: 0,
    slept: 0,
    deferred: 0,
    failed: 0,
    exhausted: 0,
  };

  stats.reconciled = await reconcileUnscheduledSessionSleeps(env, db, batchSize);

  const candidates = await db
    .select({
      snapshotId: schema.sessionSnapshots.id,
      workspaceId: schema.sessionSnapshots.workspaceId,
      userId: schema.sessionSnapshots.userId,
      chatSessionId: schema.sessionSnapshots.chatSessionId,
      sleepAttempts: schema.sessionSnapshots.sleepAttempts,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepAfter: schema.sessionSnapshots.sleepAfter,
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
    if (
      !candidate.workspaceId ||
      (candidate.sleepStatus !== 'stopping' && candidate.sleepAttempts >= maxAttempts)
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
    const claimId = crypto.randomUUID();
    if (candidate.sleepStatus !== 'stopping') {
      const eligibility = await checkAutomaticSessionSleepEligibility(env, {
        workspaceId: candidate.workspaceId,
        userId: candidate.userId,
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

    try {
      await sleepWorkspaceSession(env, {
        workspaceId: candidate.workspaceId,
        userId: candidate.userId,
        reason: 'Idle timeout elapsed',
        sleepClaimId: claimId,
      });
      stats.slept++;
    } catch (error) {
      const attempts = candidate.sleepAttempts + 1;
      const exhausted = attempts >= maxAttempts;
      await failSessionSnapshotSleepBeforeTeardown(
        db,
        env,
        candidate.chatSessionId,
        claimId,
        sessionLifecycleError(env, error)
      );
      stats.failed++;
      if (exhausted) stats.exhausted++;
      log.warn('session_sleep_sweep.failed', {
        snapshotId: candidate.snapshotId,
        workspaceId: candidate.workspaceId,
        chatSessionId: candidate.chatSessionId,
        attempts,
        exhausted,
        error: sessionLifecycleError(env, error),
      });
    }
  }

  return stats;
}
