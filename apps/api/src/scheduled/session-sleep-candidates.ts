/**
 * Candidate selection for the session-sleep sweep (`runSessionSleepSweep`). Split out
 * of `session-sleep.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { rearmableSessionSleepBlockSql } from '../services/session-sleep-fallback-record';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS } from '../services/session-snapshots';

function claimLeaseCutoff(env: Env, now: Date): string {
  return new Date(
    now.getTime() -
      parsePositiveInt(
        (env as Env & { SESSION_SLEEP_CLAIM_LEASE_MS?: string }).SESSION_SLEEP_CLAIM_LEASE_MS,
        DEFAULT_SESSION_SLEEP_CLAIM_LEASE_MS
      )
  ).toISOString();
}

/**
 * Due sleep intents, including legacy failures and preservation blocks now owned
 * by the guarded bounded fallback. Claims and identity checks fence each action.
 */
export function selectSweepCandidates(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  now: Date,
  batchSize: number,
  _maxAttempts: number
) {
  const nowIso = now.toISOString();
  const staleClaim = claimLeaseCutoff(env, now);
  const snapshots = schema.sessionSnapshots;
  return db
    .select({
      snapshotId: snapshots.id,
      workspaceId: snapshots.workspaceId,
      userId: snapshots.userId,
      chatSessionId: snapshots.chatSessionId,
      sleepAttempts: snapshots.sleepAttempts,
      sleepStatus: snapshots.sleepStatus,
      sleepAfter: snapshots.sleepAfter,
      sleepClaimId: snapshots.sleepClaimId,
      sleepClaimedAt: snapshots.sleepClaimedAt,
      sleepError: snapshots.sleepError,
      sleepFallbackJson: snapshots.sleepFallbackJson,
      sleepEpisodeStartedAt: snapshots.sleepEpisodeStartedAt,
      sleepEpisodeFailures: snapshots.sleepEpisodeFailures,
      updatedAt: snapshots.updatedAt,
      status: snapshots.status,
      captureGeneration: snapshots.captureGeneration,
      workspaceStatus: schema.workspaces.status,
    })
    .from(snapshots)
    .leftJoin(schema.workspaces, eq(schema.workspaces.id, snapshots.workspaceId))
    .where(
      and(
        inArray(snapshots.status, ['pending', 'available', 'degraded', 'failed', 'expired']),
        isNull(snapshots.sleepingAt),
        or(
          and(
            eq(snapshots.sleepStatus, 'terminal_failed'),
            // Historical snapshots outlive removed/replaced workspaces. They must
            // not consume the bounded live-cleanup page forever.
            inArray(schema.workspaces.status, ['running', 'recovery', 'sleeping', 'stopped']),
            eq(schema.workspaces.nodeId, snapshots.nodeId),
            eq(schema.workspaces.userId, snapshots.userId),
            eq(schema.workspaces.projectId, snapshots.projectId),
            eq(schema.workspaces.chatSessionId, snapshots.chatSessionId),
            or(isNull(snapshots.sleepAfter), lte(snapshots.sleepAfter, nowIso)),
            sql.raw(rearmableSessionSleepBlockSql('session_snapshots'))
          ),
          and(
            eq(snapshots.sleepStatus, 'terminal_failed'),
            lte(snapshots.sleepAfter, nowIso),
            sql`CASE WHEN json_valid(${snapshots.sleepFallbackJson}) THEN json_extract(${snapshots.sleepFallbackJson}, '$.blockedReason') END = 'runtime_changed'`
          ),
          and(
            inArray(snapshots.sleepStatus, ['scheduled', 'failed']),
            lte(snapshots.sleepAfter, nowIso)
          ),
          // Legacy exhausted failures must converge through the same guarded fallback.
          and(
            eq(snapshots.sleepStatus, 'failed'),
            isNull(snapshots.sleepAfter),
            sql`${snapshots.sleepAttempts} >= 0`
          ),
          and(
            eq(snapshots.sleepStatus, 'preparing'),
            or(isNull(snapshots.sleepClaimedAt), lte(snapshots.sleepClaimedAt, staleClaim))
          ),
          and(
            eq(snapshots.sleepStatus, 'stopping'),
            // Teardown retries must still have an owner after the in-flight
            // preservation window. Their immutable episode budget bounds them.
            or(
              lte(snapshots.sleepAfter, nowIso),
              isNull(snapshots.sleepClaimedAt),
              lte(snapshots.sleepClaimedAt, staleClaim)
            )
          )
        )
      )
    )
    .orderBy(snapshots.sleepAfter, snapshots.id)
    .limit(batchSize);
}
