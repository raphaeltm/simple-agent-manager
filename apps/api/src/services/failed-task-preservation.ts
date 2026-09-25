/**
 * Failed-task work preservation.
 *
 * A failed task used to be torn down on the spot (`failSession` then
 * `cleanupTaskRun`). That destroyed uncommitted and unpushed work in its
 * workspace, and left a ProjectData chat session that snapshot recovery refuses
 * to wake: `wakeSessionForSnapshotRecovery` only wakes a `sleeping` session onto
 * its replacement workspace, never a `failed` one. A failed task now gets what a
 * completed one gets: a final snapshot, then a sleep, so the conversation stays
 * wakeable, forkable and retryable for the snapshot TTL (policy `a3780107`; idea
 * `01M1XGHX7NQZQYWQRV5C1PJ60N`).
 *
 * Entry points that consult {@link preserveFailedTaskWork} (`.claude/rules/44`
 * and `/61` — every live-work path into failed-task cleanup, on both runtimes):
 *
 * - `cleanupTerminalTaskResources` for `status: 'failed'` without destructive
 *   intent: the VM / standalone-agent failure callback, the task status route and
 *   explicit run cleanup (`cleanupRequestedTaskRun`).
 * - `attention-expiry.ts` for expired human-input and SAM check-in markers.
 *
 * Deliberately NOT routed here: explicit archive/delete (`destructiveSessionEnd`,
 * policy `e8897480`), parent stops (`cancelled`, policy `486d1dd1`), startup
 * failures that never ran an agent, runtime-already-gone verdicts, and the
 * compaction-loop / runaway-cost kill switches, whose intent is an immediate stop.
 *
 * The session-sleep machinery treats `failed` like `completed` through the one
 * shared authority in `sleep-preserved-task-status.ts`, and the sleep sweep gives
 * up on a preservation that can no longer complete (`failed-task-preservation-release.ts`),
 * so a runtime that can never be snapshotted is still torn down (`.claude/rules/47`).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import { queueWorkspaceSessionSleep } from './session-sleep';
import { chatSessionTaskOwnerJoins } from './session-sleep-task-owner';
import { scheduleSessionSnapshotSleep } from './session-snapshots';
import {
  SLEEP_CLAIMABLE_NODE_ROLE,
  SLEEP_CLAIMABLE_WORKSPACE_STATUSES,
  SLEEP_RESUMABLE_AGENT_SESSION_STATUSES,
  SLEEP_SNAPSHOT_NODE_RUNTIMES,
} from './sleep-preserved-task-status';
import { loadTaskSleepPreservation } from './task-sleep-preservation';

/** Why a failed task's runtime could not be handed to the sleep lifecycle. */
export type FailedTaskPreservationGap =
  | 'no_workspace'
  | 'workspace_not_live'
  | 'no_chat_session'
  | 'unsupported_runtime'
  | 'no_resumable_agent_session'
  | 'sleep_queue_failed'
  /** The check-in watchdog failed an agent that is still mid-turn (`attention-expiry.ts`). */
  | 'agent_unresponsive';

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
        inArray(schema.agentSessions.status, SLEEP_RESUMABLE_AGENT_SESSION_STATUSES)
      )
    )
    .limit(1);
  return { ...workspace, agentSessionId: agentSession?.id ?? null };
}

/**
 * The sleep claimer's own preconditions (`reconcileUnscheduledSessionSleeps`), read
 * from the shared constants, so a runtime is only handed over when the sleep sweep
 * can actually claim it.
 */
function liveRuntimeGap(workspace: PreservationWorkspace | null): FailedTaskPreservationGap | null {
  if (!workspace) return 'no_workspace';
  if (!(SLEEP_CLAIMABLE_WORKSPACE_STATUSES as readonly string[]).includes(workspace.status)) {
    return 'workspace_not_live';
  }
  // The sleep is queued against the workspace's own chat link. A wake handoff
  // nulls it, and then this workspace no longer owns the conversation.
  if (!workspace.chatSessionId) return 'no_chat_session';
  if (
    workspace.nodeRole !== SLEEP_CLAIMABLE_NODE_ROLE ||
    !(SLEEP_SNAPSHOT_NODE_RUNTIMES as readonly string[]).includes(workspace.runtime ?? '')
  ) {
    return 'unsupported_runtime';
  }
  if (!workspace.agentSessionId) return 'no_resumable_agent_session';
  return null;
}

/** Why the sleep lifecycle can no longer claim this failed task's runtime, if it can't. */
export async function failedTaskRuntimeGap(
  env: Env,
  projectId: string,
  workspaceId: string
): Promise<FailedTaskPreservationGap | null> {
  return liveRuntimeGap(await loadPreservationWorkspace(env, projectId, workspaceId));
}

/**
 * Queue the failed runtime's sleep as a NEW sleep episode, and report whether the
 * row now holds a due intent. `queueWorkspaceSessionSleep` never resets the retry
 * budget, because its reconciler caller runs every tick and must not launder a
 * crashing row into unlimited retries. A task failure is a one-off terminal event
 * — positive evidence of a new episode (`.claude/rules/61`) — so a budget an
 * earlier, unrelated sleep of this still-running workspace spent must not end
 * preservation before it has made a single attempt. The reset runs first, so an
 * existing row is never due with the stale budget, and again after the queue
 * (which creates the row when missing) to confirm an intent was written.
 */
async function queueFailedTaskSleepEpisode(
  env: Env,
  workspace: PreservationWorkspace & { chatSessionId: string }
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const startEpisode = () =>
    scheduleSessionSnapshotSleep(db, env, workspace.chatSessionId, new Date(), {
      sleepAfterMs: 0,
      allowIncomplete: true,
      resetAttempts: true,
    });
  await startEpisode();
  await queueWorkspaceSessionSleep(env, {
    workspaceId: workspace.id,
    userId: workspace.userId,
    reason: FAILED_TASK_SLEEP_REASON,
    sleepAfterMs: 0,
  });
  return startEpisode();
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
 * idle-sleep intent may be far in the future and a failure must sleep now. When
 * no due intent results — no live runtime, or a sleep already in flight or done
 * — the chat's existing sleep state decides, read through the same predicate the
 * resumer reads (`.claude/rules/58`).
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
  if (!gap && workspace?.chatSessionId) {
    try {
      const queued = await queueFailedTaskSleepEpisode(env, {
        ...workspace,
        chatSessionId: workspace.chatSessionId,
      });
      if (queued) return decided(input, { outcome: 'sleep_queued' });
      // Nothing due was written: the row is asleep, mid-sleep, or in a state the
      // sleep lifecycle does not schedule from. The check below tells them apart.
    } catch (err) {
      log.warn('task.failure_preservation.sleep_queue_failed', {
        taskId: input.taskId,
        projectId: input.projectId,
        workspaceId: workspace.id,
        source: input.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    gap = 'sleep_queue_failed';
  }

  const sleep = await loadTaskSleepPreservation(env.DATABASE, env, {
    id: input.taskId,
    projectId: input.projectId,
    chatSessionId: input.chatSessionId ?? workspace?.chatSessionId ?? null,
  });
  if (sleep.outcome === 'preserve') {
    // The conversation slept before it failed; its snapshot may already be
    // incomplete, and no later sleep will be there to say so.
    const chatSessionId = input.chatSessionId ?? workspace?.chatSessionId ?? null;
    if (chatSessionId) {
      // Best effort: the note must never turn a kept conversation into an error.
      await noteFailedTaskPreservationCapture(env, { chatSessionId }).catch((err: unknown) => {
        log.warn('task.failure_preservation.capture_note_failed', {
          taskId: input.taskId,
          chatSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return decided(input, { outcome: 'already_asleep' });
  }
  if (sleep.outcome === 'unknown') return decided(input, { outcome: 'unknown' });
  return decided(input, { outcome: 'not_preservable', gap: gap ?? 'workspace_not_live' });
}

export type FailedTaskWorkLossReason =
  | FailedTaskPreservationGap
  | 'snapshot_retry_exhausted'
  | 'snapshot_unavailable'
  | 'preservation_timed_out';

const WORK_LOSS_DETAIL: Record<FailedTaskWorkLossReason, string> = {
  no_workspace: 'the task has no workspace record',
  workspace_not_live: 'the workspace was no longer running',
  no_chat_session: 'the workspace is no longer linked to this conversation',
  unsupported_runtime: 'this workspace runtime cannot be snapshotted',
  no_resumable_agent_session: "the workspace's agent session had already ended",
  sleep_queue_failed: 'the workspace snapshot could not be scheduled',
  agent_unresponsive: 'the agent stopped responding in the middle of a turn',
  snapshot_retry_exhausted: 'the workspace snapshot kept failing until its retry budget ran out',
  snapshot_unavailable: 'the workspace was no longer available to snapshot',
  preservation_timed_out: 'the workspace stayed busy too long after the failure to be snapshotted',
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
    messageId: failedTaskNoticeId('work-loss', input.taskId, input.chatSessionId),
    content: failedTaskWorkLossMessage(input.reason),
  });
}

/**
 * A notice's message id: one per task run and conversation. Failure callbacks can
 * be replayed (`task.callback.idempotent`), so the same notice must land once — an
 * identical replay resolves to the existing message, a differing one is refused
 * and logged. The chat id is part of it because a failed task can be re-run into
 * a new conversation, and message ids are unique across the whole project.
 */
export function failedTaskNoticeId(
  kind: 'work-loss' | 'snapshot-incomplete',
  taskId: string,
  chatSessionId: string
): string {
  return `failed-task-${kind}-${taskId}-${chatSessionId}`;
}

/** Persist a system notice under its per-task, per-conversation message id. */
async function persistSystemNotice(
  env: Env,
  input: {
    taskId: string;
    projectId: string;
    chatSessionId: string;
    messageId: string;
    content: string;
  }
): Promise<void> {
  try {
    await projectDataService.persistMessage(
      env,
      input.projectId,
      input.chatSessionId,
      'system',
      input.content,
      null,
      input.messageId
    );
  } catch (err) {
    log.warn('task.failure_preservation.surface_failed', {
      taskId: input.taskId,
      projectId: input.projectId,
      chatSessionId: input.chatSessionId,
      messageId: input.messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface PreservationSnapshotOwner {
  projectId: string | null;
  taskFailedAt: string | null;
  runtime: string;
  sleepingAt: string | null;
  sleepStatus: string | null;
  sleepAfter: string | null;
  sleepAttempts: number;
  status: string;
  degradation: string;
  captureGeneration: string | null;
  taskId: string | null;
  taskStatus: string | null;
  taskErrorMessage: string | null;
}

/** The snapshot row joined to the task that owns its chat, as the sleep path resolves it. */
export async function loadPreservationSnapshotOwner(
  env: Env,
  chatSessionId: string
): Promise<PreservationSnapshotOwner | null> {
  const db = drizzle(env.DATABASE, { schema });
  const owner = chatSessionTaskOwnerJoins(schema.sessionSnapshots.chatSessionId);
  const [row] = await db
    .select({
      projectId: schema.sessionSnapshots.projectId,
      runtime: schema.sessionSnapshots.runtime,
      sleepingAt: schema.sessionSnapshots.sleepingAt,
      sleepStatus: schema.sessionSnapshots.sleepStatus,
      sleepAfter: schema.sessionSnapshots.sleepAfter,
      sleepAttempts: schema.sessionSnapshots.sleepAttempts,
      status: schema.sessionSnapshots.status,
      degradation: schema.sessionSnapshots.degradation,
      captureGeneration: schema.sessionSnapshots.captureGeneration,
      taskId: schema.tasks.id,
      taskStatus: schema.tasks.status,
      taskErrorMessage: schema.tasks.errorMessage,
      taskFailedAt: sql<
        string | null
      >`COALESCE(${schema.tasks.completedAt}, ${schema.tasks.updatedAt})`,
    })
    .from(schema.sessionSnapshots)
    .leftJoin(schema.sessionSummaries, owner.summary)
    .leftJoin(schema.tasks, owner.task)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .limit(1);
  return row ?? null;
}

/** Degradations that mean the workspace files themselves were not fully captured. */
const FILE_LOSS_DEGRADATIONS = new Set(['transcript-only', 'wip-skipped', 'entries-skipped']);

/**
 * After a failed task's workspace has slept, say so when its snapshot is missing
 * workspace files. Without this a degraded capture is indistinguishable from a
 * complete one until the user wakes the session and finds the changes gone. An
 * Instant workspace wakes in place only, and its container is kept only for a
 * complete snapshot (`cleanupTaskRun`), so any degradation means no restore at all.
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
    (owner.runtime !== 'cf-container' && !FILE_LOSS_DEGRADATIONS.has(owner.degradation))
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
    messageId: failedTaskNoticeId('snapshot-incomplete', owner.taskId, input.chatSessionId),
    content: failedTaskIncompleteSnapshotMessage(owner.degradation, owner.runtime),
  });
}

export function failedTaskIncompleteSnapshotMessage(degradation: string, runtime: string): string {
  const consequence =
    runtime === 'cf-container'
      ? 'so this Instant workspace cannot be restored.'
      : 'so some uncommitted or unpushed changes may be missing when it wakes.';
  return (
    `Task failed. SAM saved this conversation, but its workspace snapshot is incomplete ` +
    `(${degradation}), ${consequence}`
  );
}
