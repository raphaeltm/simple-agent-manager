/**
 * The session-sleep sweep's half of failed-task work preservation: the bounded
 * escapes for a preservation sleep that can no longer complete
 * (`.claude/rules/47`, `.claude/rules/58` requirement 3). Each ends the sleep
 * episode, says so in the chat, fails the session and tears the runtime down, so
 * a failed task is never left `active` behind a sleep that will not happen.
 *
 * If a release never runs, the node-cleanup reapers still take the runtime:
 * `sleepLifecycleOwnsTerminalTaskWorkspaceSql` stops exempting a failed task's
 * workspace once its sleep is exhausted or the claimer can no longer take it.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  failedTaskRuntimeGap,
  type FailedTaskWorkLossReason,
  loadPreservationSnapshotOwner,
  type PreservationSnapshotOwner,
  surfaceFailedTaskWorkLoss,
} from './failed-task-preservation';
import * as projectDataService from './project-data';
import { TERMINAL_SESSION_SLEEP_STATUS } from './session-snapshot-sleep-failure';
import {
  isSessionSleepExhausted,
  sessionSleepMaxAttempts,
  SLEEP_RESUMABLE_AGENT_SESSION_STATUSES,
} from './sleep-preserved-task-status';
import { cleanupTaskRun } from './task-runner';

/**
 * Longest a failed task's runtime may stay awake waiting for its preservation
 * sleep, measured from the start of its current episode (`preservationWaitedTooLong`).
 * Normally the sleep lands within a sweep or two; this bounds an agent that keeps
 * one turn open (a hung prompt under an unbounded prompt timeout) and a runtime
 * whose activity state never resolves.
 */
export const DEFAULT_FAILED_TASK_PRESERVATION_MAX_WAIT_MS = 8 * 60 * 60 * 1000;

type FailedTaskOwner = PreservationSnapshotOwner & { taskId: string; projectId: string };

function failedTaskOwner(owner: PreservationSnapshotOwner | null): FailedTaskOwner | null {
  if (!owner?.taskId || !owner.projectId || owner.taskStatus !== 'failed') return null;
  return { ...owner, taskId: owner.taskId, projectId: owner.projectId };
}

/**
 * End the preservation's sleep episode so the sweep stops retrying it and the
 * reapers see it as given up. A compare-and-set on exactly the row state the
 * caller read: a sleep in flight, a completed sleep, or a fresh episode queued in
 * between (a replayed failure callback, an explicit run cleanup) is left alone.
 */
async function endFailedTaskSleepEpisode(
  env: Env,
  owner: FailedTaskOwner,
  chatSessionId: string,
  reason: FailedTaskWorkLossReason
): Promise<boolean> {
  const now = new Date().toISOString();
  const snapshots = schema.sessionSnapshots;
  const result = await drizzle(env.DATABASE, { schema })
    .update(snapshots)
    .set({
      sleepStatus: TERMINAL_SESSION_SLEEP_STATUS,
      sleepAfter: null,
      sleepError: `Failed-task preservation ended: ${reason}`,
      sleepClaimId: null,
      sleepClaimedAt: null,
      sleepStoppingSince: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(snapshots.chatSessionId, chatSessionId),
        isNull(snapshots.sleepingAt),
        or(
          isNull(snapshots.sleepStatus),
          inArray(snapshots.sleepStatus, ['scheduled', 'failed', TERMINAL_SESSION_SLEEP_STATUS])
        ),
        sql`${snapshots.sleepStatus} IS ${owner.sleepStatus}`,
        sql`${snapshots.sleepAfter} IS ${owner.sleepAfter}`,
        eq(snapshots.sleepAttempts, owner.sleepAttempts)
      )
    );
  return (result.meta.changes ?? 0) > 0;
}

async function abandonFailedTaskPreservation(
  env: Env,
  owner: FailedTaskOwner,
  chatSessionId: string,
  reason: FailedTaskWorkLossReason
): Promise<boolean> {
  if (!(await endFailedTaskSleepEpisode(env, owner, chatSessionId, reason))) return false;
  await surfaceFailedTaskWorkLoss(env, {
    taskId: owner.taskId,
    projectId: owner.projectId,
    chatSessionId,
    reason,
    source: 'session_sleep.preservation_abandoned',
  });
  try {
    await projectDataService.failSession(
      env,
      owner.projectId,
      chatSessionId,
      owner.taskErrorMessage
    );
  } catch (err) {
    log.warn('task.failure_preservation.abandoned_session_fail_failed', {
      taskId: owner.taskId,
      chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await cleanupTaskRun(owner.taskId, env);
  return true;
}

/**
 * Called by the sleep sweep after a failed or given-up sleep attempt. Acts once the
 * sleep lifecycle has given up (`isSessionSleepExhausted`) — or, for a failed task,
 * once the retry budget is spent even on a repairable capture, which other sleeps
 * keep retrying indefinitely. A capture still inside its budget is left alone.
 * Completed tasks keep the pre-existing behaviour. Returns true when it released.
 */
export async function releaseExhaustedFailedTaskPreservation(
  env: Env,
  input: { chatSessionId: string }
): Promise<boolean> {
  const owner = failedTaskOwner(await loadPreservationSnapshotOwner(env, input.chatSessionId));
  if (!owner) return false;
  const maxAttempts = sessionSleepMaxAttempts(env);
  const budgetSpent =
    !owner.sleepingAt && owner.sleepStatus === 'failed' && owner.sleepAttempts >= maxAttempts;
  if (!isSessionSleepExhausted(owner, maxAttempts) && !budgetSpent) return false;
  return abandonFailedTaskPreservation(
    env,
    owner,
    input.chatSessionId,
    owner.sleepStatus === TERMINAL_SESSION_SLEEP_STATUS
      ? 'snapshot_unavailable'
      : 'snapshot_retry_exhausted'
  );
}

function timeOf(value: string | null): number {
  const parsed = Date.parse(value ?? '');
  // An unreadable time cannot prove the wait is still bounded.
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * When the agent's current turn started, read as the sweep's own eligibility check
 * reads it (`checkAutomaticSessionSleepEligibility`): the workspace's latest
 * resumable agent session, then its ProjectData state. `null` when no turn is
 * recorded; `undefined` when the lookup failed.
 */
async function currentTurnStartedAt(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<number | null | undefined> {
  try {
    const [agentSession] = await drizzle(env.DATABASE, { schema })
      .select({ id: schema.agentSessions.id })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.workspaceId, workspaceId),
          inArray(schema.agentSessions.status, SLEEP_RESUMABLE_AGENT_SESSION_STATUSES)
        )
      )
      .orderBy(desc(schema.agentSessions.createdAt))
      .limit(1);
    if (!agentSession) return null;
    const state = await projectDataService.getSessionState(env, projectId, agentSession.id);
    const startedAt = state?.promptStartedAt;
    return typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null;
  } catch (err) {
    log.warn('task.failure_preservation.turn_lookup_failed', {
      projectId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * The maximum wait runs from the latest sign that the conversation's current
 * episode began: the failure, an in-place wake (an Instant conversation wakes
 * under the same failed task), or the start of the agent's current turn. A user
 * who keeps the conversation busy restarts it with every turn; only one turn that
 * never ends, or a state that never resolves, runs it out (`.claude/rules/74`).
 * A failed turn lookup withholds the teardown until the next sweep.
 */
async function preservationWaitedTooLong(
  env: Env,
  owner: FailedTaskOwner,
  workspaceId: string,
  now: Date
): Promise<boolean> {
  const maxWaitMs = parsePositiveInt(
    env.FAILED_TASK_PRESERVATION_MAX_WAIT_MS,
    DEFAULT_FAILED_TASK_PRESERVATION_MAX_WAIT_MS
  );
  const episodeStartedAt = Math.max(timeOf(owner.taskFailedAt), timeOf(owner.restoredAt));
  // The turn lookup costs a ProjectData call: make it only when the cheap anchors
  // already say the wait is over.
  if (now.getTime() - episodeStartedAt <= maxWaitMs) return false;
  const turnStartedAt = await currentTurnStartedAt(env, owner.projectId, workspaceId);
  if (turnStartedAt === undefined) return false;
  return now.getTime() - Math.max(episodeStartedAt, turnStartedAt ?? 0) > maxWaitMs;
}

/**
 * Called by the sleep sweep when it defers a candidate, which spends no attempt,
 * so the retry budget alone cannot end a preservation that keeps being deferred.
 * Releases when the runtime can no longer be claimed — a fatal agent error flips
 * the agent session to `error` after the sleep was queued, or a reaper stopped the
 * workspace — or once the current episode has waited longer than
 * `FAILED_TASK_PRESERVATION_MAX_WAIT_MS`. Returns true when it released.
 */
export async function releaseStalledFailedTaskPreservation(
  env: Env,
  input: { chatSessionId: string; workspaceId: string },
  now = new Date()
): Promise<boolean> {
  const owner = failedTaskOwner(await loadPreservationSnapshotOwner(env, input.chatSessionId));
  if (!owner || owner.sleepingAt) return false;
  const gap = await failedTaskRuntimeGap(env, owner.projectId, input.workspaceId);
  const reason =
    gap ??
    ((await preservationWaitedTooLong(env, owner, input.workspaceId, now))
      ? 'preservation_timed_out'
      : null);
  if (!reason) return false;
  return abandonFailedTaskPreservation(env, owner, input.chatSessionId, reason);
}
