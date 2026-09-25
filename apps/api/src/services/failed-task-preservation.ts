/**
 * Failed-task work preservation.
 *
 * A failed task used to be torn down on the spot (`failSession` then
 * `cleanupTaskRun`). That destroyed uncommitted and unpushed work in its
 * workspace, and left a ProjectData chat session that snapshot recovery refuses
 * to wake (`wakeSessionForSnapshotRecovery` accepts `sleeping`, never `failed`).
 * A failed task now gets what a completed one gets: a final snapshot, then a
 * sleep, so the conversation stays wakeable, forkable and retryable for the
 * snapshot TTL (policy `a3780107`; idea `01M1XGHX7NQZQYWQRV5C1PJ60N`).
 *
 * Entry points that consult {@link preserveFailedTaskWork} (`.claude/rules/44`
 * and `/61` — every live-work path into failed-task cleanup, on both runtimes):
 *
 * - `cleanupTerminalTaskResources` for `status: 'failed'` without destructive
 *   intent: the VM / standalone-agent failure callback and the task status route.
 * - `attention-expiry.ts` for expired human-input and SAM check-in markers.
 *
 * Deliberately NOT routed here: explicit archive/delete (`destructiveSessionEnd`,
 * policy `e8897480`), parent stops (`cancelled`, policy `486d1dd1`), startup
 * failures that never ran an agent, runtime-already-gone verdicts, and the
 * compaction-loop / runaway-cost kill switches, whose intent is an immediate stop.
 *
 * The session-sleep machinery treats `failed` like `completed` through the one
 * shared authority in `sleep-preserved-task-status.ts`, and the sleep sweep hands
 * an exhausted preservation back here ({@link releaseExhaustedFailedTaskPreservation})
 * so a runtime that can never be snapshotted is still torn down (`.claude/rules/47`).
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { queueWorkspaceSessionSleep } from './session-sleep';
import { cleanupTaskRun } from './task-runner';
import { loadTaskSleepPreservation } from './task-sleep-preservation';

/** Why a failed task's runtime could not be handed to the sleep lifecycle. */
export type FailedTaskPreservationGap =
  | 'no_workspace'
  | 'workspace_not_live'
  | 'no_chat_session'
  | 'unsupported_runtime'
  | 'no_resumable_agent_session'
  | 'sleep_queue_failed';

export type FailedTaskPreservation =
  /** A live runtime: its snapshot-backed sleep is queued. */
  | { outcome: 'sleep_queued' }
  /** The conversation is already asleep, or its sleep is in flight. */
  | { outcome: 'already_asleep' }
  /** The lookup failed; destruction is withheld (`.claude/rules/58` requirement 4). */
  | { outcome: 'unknown' }
  /** Nothing to hand to the sleep lifecycle; the caller tears down and says so. */
  | { outcome: 'not_preservable'; gap: FailedTaskPreservationGap };

/** True when the caller must leave the session and the runtime alone. */
export function withholdsFailedTaskTeardown(
  preservation: FailedTaskPreservation
): preservation is Exclude<FailedTaskPreservation, { outcome: 'not_preservable' }> {
  return preservation.outcome !== 'not_preservable';
}

export const FAILED_TASK_SLEEP_REASON = 'Task failed';

// These mirror the sleep lifecycle's own preconditions, so a runtime is only
// handed over when the sleep sweep can actually claim it:
// `reconcileUnscheduledSessionSleeps` (scheduled/session-sleep.ts) and
// `queueWorkspaceSessionSleep` / `sleepWorkspaceSession` (services/session-sleep.ts).
const LIVE_WORKSPACE_STATUSES = ['running', 'recovery'];
const SNAPSHOT_RUNTIMES = ['vm', 'cf-container'];
const RESUMABLE_AGENT_SESSION_STATUSES = ['running', 'recovery', 'sleeping'];

interface PreservationWorkspace {
  id: string;
  userId: string;
  status: string;
  chatSessionId: string | null;
  nodeRole: string | null;
  runtime: string | null;
  agentSessionId: string | null;
}

async function loadPreservationWorkspace(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<PreservationWorkspace | null> {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      status: schema.workspaces.status,
      chatSessionId: schema.workspaces.chatSessionId,
      nodeRole: schema.nodes.nodeRole,
      runtime: schema.nodes.runtime,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.projectId, projectId)))
    .limit(1);
  if (!workspace) return null;
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspaceId),
        inArray(schema.agentSessions.status, RESUMABLE_AGENT_SESSION_STATUSES)
      )
    )
    .limit(1);
  return { ...workspace, agentSessionId: agentSession?.id ?? null };
}

function liveRuntimeGap(workspace: PreservationWorkspace | null): FailedTaskPreservationGap | null {
  if (!workspace) return 'no_workspace';
  if (!LIVE_WORKSPACE_STATUSES.includes(workspace.status)) return 'workspace_not_live';
  // The sleep is queued against the workspace's own chat link. A wake handoff
  // nulls it, and then this workspace no longer owns the conversation.
  if (!workspace.chatSessionId) return 'no_chat_session';
  if (workspace.nodeRole !== 'workspace' || !SNAPSHOT_RUNTIMES.includes(workspace.runtime ?? '')) {
    return 'unsupported_runtime';
  }
  if (!workspace.agentSessionId) return 'no_resumable_agent_session';
  return null;
}

function decided(
  input: { taskId: string; projectId: string; workspaceId: string | null; source: string },
  preservation: FailedTaskPreservation
): FailedTaskPreservation {
  // One structured event per decision, aggregatable by outcome and gap.
  log.info('task.failure_preservation.decided', {
    taskId: input.taskId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    source: input.source,
    outcome: preservation.outcome,
    gap: preservation.outcome === 'not_preservable' ? preservation.gap : null,
  });
  return preservation;
}

/**
 * Decide, and where possible start, preservation of a failed task's work. The
 * task row must already be `failed`; this never changes task or session status.
 *
 * Order matters: a live runtime is always (re)queued first, because an earlier
 * idle-sleep intent may be far in the future and a failure must sleep now. Only
 * when no live runtime can be handed over does the chat's existing sleep state
 * decide, read through the same predicate the resumer reads (`.claude/rules/58`).
 */
export async function preserveFailedTaskWork(
  env: Env,
  input: {
    taskId: string;
    projectId: string;
    workspaceId: string | null;
    /** The task's own chat session; the workspace link can be nulled by a wake handoff. */
    chatSessionId: string | null;
    source: string;
  }
): Promise<FailedTaskPreservation> {
  let workspace: PreservationWorkspace | null = null;
  try {
    workspace = input.workspaceId
      ? await loadPreservationWorkspace(env, input.projectId, input.workspaceId)
      : null;
  } catch (err) {
    log.warn('task.failure_preservation.lookup_failed', {
      taskId: input.taskId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      source: input.source,
      action: 'withheld_teardown',
      error: err instanceof Error ? err.message : String(err),
    });
    return decided(input, { outcome: 'unknown' });
  }

  let gap = liveRuntimeGap(workspace);
  if (!gap && workspace) {
    try {
      await queueWorkspaceSessionSleep(env, {
        workspaceId: workspace.id,
        userId: workspace.userId,
        reason: FAILED_TASK_SLEEP_REASON,
        sleepAfterMs: 0,
      });
      return decided(input, { outcome: 'sleep_queued' });
    } catch (err) {
      log.warn('task.failure_preservation.sleep_queue_failed', {
        taskId: input.taskId,
        projectId: input.projectId,
        workspaceId: workspace.id,
        source: input.source,
        error: err instanceof Error ? err.message : String(err),
      });
      gap = 'sleep_queue_failed';
    }
  }

  const sleep = await loadTaskSleepPreservation(env.DATABASE, env, {
    id: input.taskId,
    projectId: input.projectId,
    chatSessionId: input.chatSessionId ?? workspace?.chatSessionId ?? null,
  });
  if (sleep.outcome === 'preserve') return decided(input, { outcome: 'already_asleep' });
  if (sleep.outcome === 'unknown') return decided(input, { outcome: 'unknown' });
  return decided(input, { outcome: 'not_preservable', gap: gap ?? 'workspace_not_live' });
}

export type FailedTaskWorkLossReason = FailedTaskPreservationGap | 'snapshot_retry_exhausted';

const WORK_LOSS_DETAIL: Record<FailedTaskWorkLossReason, string> = {
  no_workspace: 'the task has no workspace record',
  workspace_not_live: 'the workspace was no longer running',
  no_chat_session: 'the workspace is no longer linked to this conversation',
  unsupported_runtime: 'this workspace runtime cannot be snapshotted',
  no_resumable_agent_session: "the workspace's agent session had already ended",
  sleep_queue_failed: 'the workspace snapshot could not be scheduled',
  snapshot_retry_exhausted: 'the workspace snapshot kept failing until its retry budget ran out',
};

export function failedTaskWorkLossMessage(reason: FailedTaskWorkLossReason): string {
  return (
    `Task failed and SAM could not preserve its workspace: ${WORK_LOSS_DETAIL[reason]}. ` +
    'Uncommitted or unpushed changes in that workspace were not saved; ' +
    'commits already pushed are unaffected.'
  );
}

/**
 * Surface, in the conversation itself, that a failed task's work was NOT
 * preserved. Called before the session is failed, so the message lands while the
 * session still accepts writes. Best effort: surfacing must never block teardown.
 */
export async function surfaceFailedTaskWorkLoss(
  env: Env,
  input: {
    taskId: string;
    projectId: string;
    chatSessionId: string | null;
    reason: FailedTaskWorkLossReason;
    source: string;
  }
): Promise<void> {
  log.warn('task.failure_preservation.work_not_preserved', {
    taskId: input.taskId,
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    reason: input.reason,
    source: input.source,
  });
  if (!input.chatSessionId) return;
  await persistSystemNotice(env, {
    taskId: input.taskId,
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    content: failedTaskWorkLossMessage(input.reason),
  });
}

async function persistSystemNotice(
  env: Env,
  input: { taskId: string; projectId: string; chatSessionId: string; content: string }
): Promise<void> {
  try {
    await projectDataService.persistMessage(
      env,
      input.projectId,
      input.chatSessionId,
      'system',
      input.content,
      null
    );
  } catch (err) {
    log.warn('task.failure_preservation.surface_failed', {
      taskId: input.taskId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface PreservationSnapshotOwner {
  projectId: string | null;
  sleepingAt: string | null;
  sleepStatus: string | null;
  sleepAfter: string | null;
  status: string;
  degradation: string;
  taskId: string | null;
  taskStatus: string | null;
  taskErrorMessage: string | null;
}

/**
 * The snapshot row joined to the task that owns the chat, resolved exactly as the
 * sleep path resolves it (`sleepWorkspaceSession`): the ProjectData summary's
 * task first, then the legacy `tasks.chat_session_id` link.
 */
async function loadPreservationSnapshotOwner(
  env: Env,
  chatSessionId: string
): Promise<PreservationSnapshotOwner | null> {
  const db = drizzle(env.DATABASE, { schema });
  const [row] = await db
    .select({
      projectId: schema.sessionSnapshots.projectId,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepAfter: schema.sessionSnapshots.sleepAfter,
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      taskId: schema.tasks.id,
      taskStatus: schema.tasks.status,
      taskErrorMessage: schema.tasks.errorMessage,
    })
    .from(schema.sessionSnapshots)
    .leftJoin(
      schema.sessionSummaries,
      eq(schema.sessionSummaries.id, schema.sessionSnapshots.chatSessionId)
    )
    .leftJoin(
      schema.tasks,
      or(
        eq(schema.tasks.id, schema.sessionSummaries.taskId),
        and(
          isNull(schema.sessionSummaries.taskId),
          eq(schema.tasks.chatSessionId, schema.sessionSnapshots.chatSessionId)
        )
      )
    )
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .limit(1);
  return row ?? null;
}

/**
 * Bounded escape for a failed task whose preservation sleep can never complete
 * (`.claude/rules/47`, `.claude/rules/58` requirement 3). Called by the sleep sweep
 * after a failed sleep attempt; it acts only once the row is truly out of
 * retries — `failed`/`terminal_failed` with no scheduled retry — so a repairable
 * capture that is still being retried is left alone. Completed tasks keep the
 * pre-existing behaviour. Returns true when it tore the runtime down.
 */
export async function releaseExhaustedFailedTaskPreservation(
  env: Env,
  input: { chatSessionId: string }
): Promise<boolean> {
  const owner = await loadPreservationSnapshotOwner(env, input.chatSessionId);
  if (
    !owner?.taskId ||
    !owner.projectId ||
    owner.taskStatus !== 'failed' ||
    owner.sleepingAt ||
    owner.sleepAfter !== null ||
    (owner.sleepStatus !== 'failed' && owner.sleepStatus !== 'terminal_failed')
  ) {
    return false;
  }
  await surfaceFailedTaskWorkLoss(env, {
    taskId: owner.taskId,
    projectId: owner.projectId,
    chatSessionId: input.chatSessionId,
    reason: 'snapshot_retry_exhausted',
    source: 'session_sleep.preservation_exhausted',
  });
  try {
    await projectDataService.failSession(
      env,
      owner.projectId,
      input.chatSessionId,
      owner.taskErrorMessage
    );
  } catch (err) {
    log.warn('task.failure_preservation.exhausted_session_fail_failed', {
      taskId: owner.taskId,
      chatSessionId: input.chatSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await cleanupTaskRun(owner.taskId, env);
  return true;
}

/** Degradations that mean the workspace files themselves were not fully captured. */
const FILE_LOSS_DEGRADATIONS = new Set(['transcript-only', 'wip-skipped', 'entries-skipped']);

/**
 * After a failed task's workspace has slept, say so when its snapshot is missing
 * workspace files. Without this a degraded capture is indistinguishable from a
 * complete one until the user wakes the session and finds the changes gone.
 */
export async function noteFailedTaskPreservationCapture(
  env: Env,
  input: { chatSessionId: string }
): Promise<void> {
  const owner = await loadPreservationSnapshotOwner(env, input.chatSessionId);
  if (
    !owner?.taskId ||
    !owner.projectId ||
    owner.taskStatus !== 'failed' ||
    !owner.sleepingAt ||
    owner.status !== 'degraded' ||
    !FILE_LOSS_DEGRADATIONS.has(owner.degradation)
  ) {
    return;
  }
  log.warn('task.failure_preservation.snapshot_incomplete', {
    taskId: owner.taskId,
    projectId: owner.projectId,
    chatSessionId: input.chatSessionId,
    degradation: owner.degradation,
  });
  await persistSystemNotice(env, {
    taskId: owner.taskId,
    projectId: owner.projectId,
    chatSessionId: input.chatSessionId,
    content: failedTaskIncompleteSnapshotMessage(owner.degradation),
  });
}

export function failedTaskIncompleteSnapshotMessage(degradation: string): string {
  return (
    `Task failed. SAM saved this conversation, but its workspace snapshot is incomplete ` +
    `(${degradation}), so some uncommitted or unpushed changes may be missing when it wakes.`
  );
}
