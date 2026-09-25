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
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
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
import { DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS } from './session-snapshots';
import { isSessionSleepExhausted } from './sleep-preserved-task-status';
import { cleanupTaskRun } from './task-runner';

type FailedTaskOwner = PreservationSnapshotOwner & { taskId: string; projectId: string };

function failedTaskOwner(owner: PreservationSnapshotOwner | null): FailedTaskOwner | null {
  if (!owner?.taskId || !owner.projectId || owner.taskStatus !== 'failed') return null;
  return { ...owner, taskId: owner.taskId, projectId: owner.projectId };
}

/**
 * End the preservation's sleep episode so the sweep stops retrying it and the
 * reapers see it as given up. Never touches a sleep that is in flight or done;
 * false means the row moved on and the caller must leave it alone.
 */
async function endFailedTaskSleepEpisode(
  env: Env,
  chatSessionId: string,
  reason: FailedTaskWorkLossReason
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await drizzle(env.DATABASE, { schema })
    .update(schema.sessionSnapshots)
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
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        isNull(schema.sessionSnapshots.sleepingAt),
        or(
          isNull(schema.sessionSnapshots.sleepStatus),
          inArray(schema.sessionSnapshots.sleepStatus, [
            'scheduled',
            'failed',
            TERMINAL_SESSION_SLEEP_STATUS,
          ])
        )
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
  if (!(await endFailedTaskSleepEpisode(env, chatSessionId, reason))) return false;
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
  const maxAttempts = parsePositiveInt(
    env.SESSION_SLEEP_MAX_ATTEMPTS,
    DEFAULT_SESSION_SLEEP_MAX_ATTEMPTS
  );
  const budgetSpent =
    !owner.sleepingAt && owner.sleepStatus === 'failed' && owner.sleepAttempts >= maxAttempts;
  if (!isSessionSleepExhausted(owner) && !budgetSpent) return false;
  return abandonFailedTaskPreservation(
    env,
    owner,
    input.chatSessionId,
    owner.sleepStatus === TERMINAL_SESSION_SLEEP_STATUS
      ? 'snapshot_unavailable'
      : 'snapshot_retry_exhausted'
  );
}

/**
 * Called by the sleep sweep when it defers a candidate. A failed task's runtime
 * can stop being claimable after its sleep was queued — a fatal agent error flips
 * the agent session to `error`, or a reaper stops the workspace — and the sweep
 * would then defer it forever without spending an attempt. Returns true when it
 * released.
 */
export async function releaseUnclaimableFailedTaskPreservation(
  env: Env,
  input: { chatSessionId: string; workspaceId: string }
): Promise<boolean> {
  const owner = failedTaskOwner(await loadPreservationSnapshotOwner(env, input.chatSessionId));
  if (!owner || owner.sleepingAt) return false;
  const gap = await failedTaskRuntimeGap(env, owner.projectId, input.workspaceId);
  if (!gap) return false;
  return abandonFailedTaskPreservation(env, owner, input.chatSessionId, gap);
}
