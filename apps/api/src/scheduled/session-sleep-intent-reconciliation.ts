import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { queueWorkspaceSessionSleep } from '../services/session-sleep';
import {
  DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS,
  sessionLifecycleError,
} from '../services/session-snapshots';
import {
  SLEEP_CLAIMABLE_NODE_ROLE,
  SLEEP_CLAIMABLE_WORKSPACE_STATUSES,
  SLEEP_RESUMABLE_AGENT_SESSION_STATUSES,
  SLEEP_SNAPSHOT_NODE_RUNTIMES,
} from '../services/sleep-preserved-task-status';

/**
 * Discovery half of the session-sleep sweep (`runSessionSleepSweep`): give every
 * claimable runtime without a sleep intent a persisted one. Split out of
 * `session-sleep.ts` (`.claude/rules/18-file-size-limits.md`).
 */
export async function reconcileUnscheduledSessionSleeps(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  batchSize: number,
  now: Date
): Promise<number> {
  // Claimable-runtime constants are shared with this claimer's mirrors.
  // Bounded D1-only discovery. Each successful candidate receives a persisted
  // sleep deadline and leaves this selector; queueWorkspaceSessionSleep does no
  // VM-agent I/O. Runtime activity is checked later, immediately before claim.
  const candidates = await db
    .selectDistinct({
      workspaceId: schema.workspaces.id,
      userId: schema.workspaces.userId,
      chatSessionId: schema.workspaces.chatSessionId,
      nodeId: schema.workspaces.nodeId,
      runtime: schema.nodes.runtime,
    })
    .from(schema.workspaces)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .innerJoin(
      schema.agentSessions,
      and(
        eq(schema.agentSessions.workspaceId, schema.workspaces.id),
        inArray(schema.agentSessions.status, SLEEP_RESUMABLE_AGENT_SESSION_STATUSES)
      )
    )
    .leftJoin(
      schema.sessionSnapshots,
      eq(schema.sessionSnapshots.chatSessionId, schema.workspaces.chatSessionId)
    )
    .where(
      and(
        inArray(schema.workspaces.status, SLEEP_CLAIMABLE_WORKSPACE_STATUSES),
        eq(schema.nodes.nodeRole, SLEEP_CLAIMABLE_NODE_ROLE),
        inArray(schema.nodes.runtime, SLEEP_SNAPSHOT_NODE_RUNTIMES),
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
      log.info('session_sleep_sweep.reconciled_missing_intent', {
        source: 'scheduled_sleep_intent_reconciliation',
        workspaceId: candidate.workspaceId,
        chatSessionId: candidate.chatSessionId,
        nodeId: candidate.nodeId,
        runtime: candidate.runtime,
        userId: candidate.userId,
      });
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
            sleepStoppingSince: null,
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
