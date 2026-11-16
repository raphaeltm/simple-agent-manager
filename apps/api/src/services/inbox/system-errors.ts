/**
 * System error inbox items, worker side (inbox slice E). The filing core is
 * `packages/operations/src/inbox-error-core.ts`; this module decides what counts as a failure of
 * each thing, builds the item's sentences, and notifies the owner once per new item.
 *
 * Failed tasks are found by `runInboxSystemErrorSweep` (cron, every minute): one scan over the
 * recently failed tasks covers every writer of `tasks.status = 'failed'` (task runner, Instant
 * launch, dispatch, VM-agent callback, stuck-task recovery, node loss, ProjectData). The VM-agent
 * callback also files inline so its existing `error` notification can open the item.
 *
 * Normal lifecycle endings never file (policy a974b04f), using the classification the code
 * already has: `transitionTaskToTerminal({lifecycleOutcome})` leaves `error_message` NULL (or the
 * status `cancelled`), a person's own status change is recorded with actor `user`, and
 * `classifyFailure()` marks parent stops, superseded wakes and human-input expiry
 * `diagnosable: false`.
 */
import {
  fileSystemError,
  getInboxLimits,
  quotedName,
  resolveSystemError,
  type SystemErrorFiled,
  type SystemErrorInput,
} from '@simple-agent-manager/operations';
import { classifyFailure } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { createOperationPorts } from '../../operation-ports';
import * as notificationService from '../notification';

export function systemErrorDeps(env: Env) {
  return { env, ports: createOperationPorts(env) };
}

/** A failed task as the classifier reads it. */
export interface FailedTaskRow {
  id: string;
  project_id: string;
  user_id: string;
  title: string | null;
  error_message: string | null;
  started_at: string | null;
  chat_session_id: string | null;
  parent_task_id: string | null;
  project_owner_id: string | null;
  /** Actor of the newest status event into `failed` (`user` when the person set it). */
  failed_by: string | null;
}

const FAILED_TASK_COLUMNS = `t.id, t.project_id, t.user_id, t.title, t.error_message, t.started_at,
  t.chat_session_id, t.parent_task_id, p.user_id AS project_owner_id,
  (SELECT e.actor_type FROM task_status_events e
    WHERE e.task_id = t.id AND e.to_status = 'failed'
    ORDER BY e.created_at DESC LIMIT 1) AS failed_by`;

export type TaskFailureVerdict =
  | { file: true; started: boolean; explanation: string; retryable: boolean }
  | { file: false; reason: 'no_error' | 'set_by_person' | 'normal_ending' };

/** Whether a failed task is a genuine failure the owner should hear about. */
export function classifyTaskFailure(row: FailedTaskRow): TaskFailureVerdict {
  const message = row.error_message?.trim();
  // `transitionTaskToTerminal({lifecycleOutcome})` writes no error for a normal ending.
  if (!message) return { file: false, reason: 'no_error' };
  // The person set it themselves (`PATCH /tasks/:id/status`): nothing to tell them.
  if (row.failed_by === 'user') return { file: false, reason: 'set_by_person' };
  const classification = classifyFailure(message);
  // Parent or user stop, superseded wake, expected human-input expiry.
  if (!classification.diagnosable) return { file: false, reason: 'normal_ending' };
  return {
    file: true,
    started: Boolean(row.started_at),
    explanation: classification.explanation,
    retryable: classification.retryable,
  };
}

/** The item for a failed task. Title and body never quote the error text. */
export function taskFailureError(
  row: FailedTaskRow,
  verdict: Extract<TaskFailureVerdict, { file: true }>
): SystemErrorInput {
  const name = quotedName(row.title, 'A task');
  // `retrySubtask` is the project owner's operation; offer it only to someone who can run it.
  const canRetry = verdict.retryable && row.project_owner_id === row.user_id;
  return {
    projectId: row.project_id,
    assigneeUserId: row.user_id,
    source: 'task',
    subjectId: row.id,
    title: verdict.started ? `${name} stopped before it finished` : `${name} couldn't start`,
    body: verdict.explanation,
    actions: [
      ...(canRetry ? (['retry'] as const) : []),
      ...(row.chat_session_id ? (['open_chat'] as const) : []),
    ],
    sourceTaskId: row.id,
    sourceSessionId: row.chat_session_id,
    links: [
      { kind: 'task', id: row.id, label: null },
      ...(row.chat_session_id ? [{ kind: 'chat', id: row.chat_session_id, label: null }] : []),
    ],
    // Failed children of one parent stack together.
    groupKey: row.parent_task_id ? `task:${row.parent_task_id}` : null,
  };
}

async function notifyFiled(
  env: Env,
  input: SystemErrorInput,
  filed: SystemErrorFiled,
  type: 'error' | 'cron_failure'
): Promise<void> {
  if (!filed.created || !env.NOTIFICATION) return;
  try {
    await notificationService.notifySystemError(env, input.assigneeUserId, {
      type,
      projectId: input.projectId,
      projectName: await notificationService.getProjectName(env, input.projectId),
      ref: filed.ref,
      title: input.title,
      body: input.body,
      taskId: input.sourceTaskId ?? null,
      sessionId: input.sourceSessionId ?? null,
    });
  } catch (error) {
    log.warn('inbox.system_error_notify_failed', {
      projectId: input.projectId,
      ref: filed.ref,
      ...serializeError(error),
    });
  }
}

/** File (or update) and notify. Never throws. */
export async function fileAndNotify(
  env: Env,
  input: SystemErrorInput,
  type: 'error' | 'cron_failure' = 'error'
): Promise<SystemErrorFiled | null> {
  const filed = await fileSystemError(systemErrorDeps(env), input);
  if (filed) await notifyFiled(env, input, filed, type);
  return filed;
}

/**
 * File the item for one failed task, when it is a genuine failure. Used inline by the VM-agent
 * task callback, which sends its own notification linking the returned ref. Never throws.
 */
export async function fileTaskFailure(
  env: Env,
  projectId: string,
  taskId: string
): Promise<SystemErrorFiled | null> {
  try {
    const row = await env.DATABASE.prepare(
      `SELECT ${FAILED_TASK_COLUMNS} FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.id = ? AND t.project_id = ? AND t.status = 'failed'`
    )
      .bind(taskId, projectId)
      .first<FailedTaskRow>();
    if (!row) return null;
    const verdict = classifyTaskFailure(row);
    if (!verdict.file) return null;
    return await fileSystemError(systemErrorDeps(env), taskFailureError(row, verdict));
  } catch (error) {
    log.error('inbox.task_failure_file_failed', { projectId, taskId, ...serializeError(error) });
    return null;
  }
}

export interface InboxSystemErrorSweepStats {
  scanned: number;
  filed: number;
  skippedNormal: number;
  closed: number;
}

/**
 * One cron step: file items for genuinely failed tasks of the lookback window that have none,
 * then close task items whose task is no longer failed (retried in place, or reset by a person).
 *
 * Budget (rule 47): one indexed scan of failed tasks updated inside `inbox.errorLookbackMinutes`
 * (`idx_tasks_failed_updated`), newest first, at most four times `inbox.errorSweepBatchSize` rows;
 * at most `inbox.errorSweepBatchSize` filings (about five D1 round trips each); one UPDATE for
 * the closes (`idx_asks_error_key`). A candidate leaves the set once it has an item (the NOT EXISTS,
 * `idx_asks_error_task`) or once it ages out
 * of the window, so a task that cannot be filed (its owner left the project) or a normal ending
 * is never retried past the window.
 */
export async function runInboxSystemErrorSweep(
  env: Env,
  now = Date.now()
): Promise<InboxSystemErrorSweepStats> {
  const deps = systemErrorDeps(env);
  const limits = await getInboxLimits(deps);
  const since = new Date(now - limits.errorLookbackMinutes * 60_000).toISOString();
  const candidates = await env.DATABASE.prepare(
    `SELECT ${FAILED_TASK_COLUMNS} FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'failed' AND t.updated_at > ?
        -- Any error item filed since the task last changed: open, archived or already closed
        -- (a retried task stays failed; its closed item must not be filed again).
        AND NOT EXISTS (SELECT 1 FROM asks a
          WHERE a.kind = 'error' AND a.source_task_id = t.id AND a.project_id = t.project_id
            AND a.created_at >= CAST((julianday(t.updated_at) - 2440587.5) * 86400000 AS INTEGER))
      ORDER BY t.updated_at DESC LIMIT ?`
  )
    .bind(since, limits.errorSweepBatchSize * 4)
    .all<FailedTaskRow>();
  const rows = candidates.results ?? [];
  let filed = 0;
  let skippedNormal = 0;
  for (const row of rows) {
    if (filed >= limits.errorSweepBatchSize) break;
    const verdict = classifyTaskFailure(row);
    if (!verdict.file) {
      skippedNormal += 1;
      continue;
    }
    const result = await fileAndNotify(env, taskFailureError(row, verdict));
    if (result) filed += 1;
  }

  // A task that left `failed` (retried in place or reset) recovered: close its item.
  const closed = await env.DATABASE.prepare(
    `UPDATE asks
        SET status = CASE WHEN status = 'open' THEN 'done' ELSE status END,
            answer_json = CASE WHEN status = 'open' THEN '{"resolution":"recovered"}' ELSE answer_json END,
            resolved_at = CASE WHEN status = 'open' THEN ? ELSE resolved_at END,
            notified_at = COALESCE(notified_at, ?), dedupe_key = NULL, updated_at = ?
      WHERE kind = 'error' AND dedupe_key IS NOT NULL AND dedupe_key LIKE 'error:task:%'
        AND status IN ('open', 'archived')
        AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = asks.source_task_id
          AND t.project_id = asks.project_id AND t.status != 'failed')`
  )
    .bind(now, now, now)
    .run();

  const stats = {
    scanned: rows.length,
    filed,
    skippedNormal,
    closed: closed.meta?.changes ?? 0,
  };
  if (stats.filed > 0 || stats.closed > 0) log.info('inbox.system_error_sweep', stats);
  return stats;
}

/** Close a recovered thing's item. Never throws. */
export function resolveSystemErrorFor(
  env: Env,
  input: Parameters<typeof resolveSystemError>[1]
): Promise<number> {
  return resolveSystemError({ env }, input);
}

/** A chat as an error item names it: its task, topic and creator (the D1 chat index). */
export async function loadChatForError(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<{ taskId: string | null; topic: string | null; createdBy: string | null } | null> {
  const row = await env.DATABASE.prepare(
    `SELECT ss.task_id, ss.topic, ss.created_by_user_id,
        (SELECT t.id FROM tasks t WHERE t.project_id = ss.project_id AND t.chat_session_id = ss.id)
          AS bound_task_id
       FROM session_summaries ss WHERE ss.id = ? AND ss.project_id = ?`
  )
    .bind(sessionId, projectId)
    .first<{
      task_id: string | null;
      topic: string | null;
      created_by_user_id: string | null;
      bound_task_id: string | null;
    }>();
  if (!row) return null;
  return {
    // `createAsk` requires the chat to be the task's own; prefer the task bound to it now.
    taskId: row.bound_task_id ?? row.task_id,
    topic: row.topic,
    createdBy: row.created_by_user_id,
  };
}

/**
 * A fallback sleep released the workspace without a fresh snapshot
 * (`session-sleep-fallback.ts:runSessionSleepFallback`): work since the last complete snapshot,
 * or everything unsaved when there is none, may be lost. Never throws.
 */
export async function fileSleepLossError(
  env: Env,
  input: { projectId: string; sessionId: string; userId: string; exactRestore: boolean }
): Promise<SystemErrorFiled | null> {
  try {
    const chat = await loadChatForError(env, input.projectId, input.sessionId);
    const name = quotedName(chat?.topic, 'A chat');
    return await fileAndNotify(env, {
      projectId: input.projectId,
      assigneeUserId: chat?.createdBy ?? input.userId,
      source: 'sleep',
      subjectId: input.sessionId,
      title: `${name} went to sleep without saving its latest work`,
      body: input.exactRestore
        ? 'SAM could not save a fresh snapshot, so it slept the chat from its last complete one; changes made after that snapshot may be lost.'
        : 'SAM could not save a snapshot before it shut the workspace down, so unsaved files and uncommitted work may be lost.',
      actions: ['open_chat'],
      sourceTaskId: chat?.taskId ?? null,
      sourceSessionId: input.sessionId,
      links: [{ kind: 'chat', id: input.sessionId, label: null }],
    });
  } catch (error) {
    log.error('inbox.sleep_loss_file_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...serializeError(error),
    });
    return null;
  }
}

/**
 * The person's answer to a permission, form or link request was never confirmed delivered to the
 * agent after the InteractionStore's retry window (`interaction-store.ts:recordDelivery`,
 * `delivery_unconfirmed`). One item per chat; never throws.
 */
export async function fileUndeliveredAnswerError(
  env: Env,
  input: { projectId: string; sessionId: string }
): Promise<SystemErrorFiled | null> {
  try {
    const chat = await loadChatForError(env, input.projectId, input.sessionId);
    if (!chat?.createdBy) return null;
    const name = quotedName(chat.topic, 'a chat');
    return await fileAndNotify(env, {
      projectId: input.projectId,
      assigneeUserId: chat.createdBy,
      source: 'delivery',
      subjectId: input.sessionId,
      title: `Your answer didn't reach the agent in ${name}`,
      body: 'SAM kept trying but the agent never confirmed it received your answer; open the chat and answer again if it is still waiting.',
      actions: ['open_chat'],
      sourceTaskId: chat.taskId,
      sourceSessionId: input.sessionId,
      links: [{ kind: 'chat', id: input.sessionId, label: null }],
    });
  } catch (error) {
    log.error('inbox.undelivered_answer_file_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...serializeError(error),
    });
    return null;
  }
}
