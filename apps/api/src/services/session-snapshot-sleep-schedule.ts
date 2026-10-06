/**
 * Persisting a sleep intent (`scheduled` with a deadline). Split out of
 * `session-snapshot-sleep-lifecycle.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { DEFAULT_CF_CONTAINER_SLEEP_AFTER } from '../durable-objects/vm-agent-container';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from './session-snapshot-artifacts';

type Db = ReturnType<typeof drizzle<typeof schema>>;

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

export async function scheduleSessionSnapshotSleep(
  db: Db,
  env: Env,
  chatSessionId: string,
  now = new Date(),
  options: {
    sleepAfterMs?: number;
    allowIncomplete?: boolean;
    resetAttempts?: boolean;
    /**
     * Start a new bounded sleep-failure episode (`session-sleep-episode.ts`). Only a
     * one-off terminal event may pass this (a task failure); a completed capture
     * generation must not, or a capture could reset the budget it is bounded by.
     */
    startNewEpisode?: boolean;
    runtime?: string;
    expectedWorkspaceId?: string;
    expectedNodeId?: string;
  } = {}
): Promise<boolean> {
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
  const scheduled = await db
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
      ...(options.startNewEpisode
        ? { sleepEpisodeStartedAt: null, sleepEpisodeFailures: 0, sleepFallbackJson: null }
        : {}),
      sleepError: null,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
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
        ),
        options.expectedWorkspaceId && options.expectedNodeId
          ? and(
              eq(schema.sessionSnapshots.workspaceId, options.expectedWorkspaceId),
              eq(schema.sessionSnapshots.nodeId, options.expectedNodeId),
              sql`EXISTS (
                SELECT 1 FROM workspaces w
                WHERE w.id = ${options.expectedWorkspaceId}
                  AND w.node_id = ${options.expectedNodeId}
                  AND w.chat_session_id = ${schema.sessionSnapshots.chatSessionId}
                  AND w.user_id = ${schema.sessionSnapshots.userId}
                  AND w.status IN ('running', 'creating', 'recovery')
              )`
            )
          : undefined
      )
    )
    .run();
  return (scheduled.meta.changes ?? 0) > 0;
}
