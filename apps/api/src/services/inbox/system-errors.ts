/**
 * System error inbox items, worker side (inbox slice E). The filing core is
 * `packages/operations/src/inbox-error-core.ts`; this module decides what counts as a failure of
 * each thing, builds the item's sentences, and notifies the owner once per new item.
 *
 * Failed tasks are found by `runInboxSystemErrorSweep` (the five-minute operational cron): one scan over the
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
  type SystemErrorFiled,
  type SystemErrorInput,
} from '@simple-agent-manager/operations';
import { classifyFailure } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log, serializeError } from '../../lib/logger';
import { createOperationPorts } from '../../operation-ports';
import * as notificationService from '../notification';
import * as projectDataService from '../project-data';

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
    // A task fails once per run; a re-report (callback and sweep both filing) is not a second.
    failureCount: 1,
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
  let filed: SystemErrorFiled | null;
  try {
    // Building the ports is inside the guard too: filing must never throw into its caller.
    filed = await fileSystemError(systemErrorDeps(env), input);
  } catch (error) {
    log.error('inbox.system_error_file_failed', {
      projectId: input.projectId,
      source: input.source,
      ...serializeError(error),
    });
    return null;
  }
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
 * Pages of the failed-task window one sweep tick may read, each `4 × inbox.errorSweepBatchSize`
 * rows. Rows the classifier skips (a parent stop, an expected expiry) stay in the window until they
 * age out of it; paging past them keeps them from holding every slot (rule 47, rule 81).
 */
const TASK_SWEEP_MAX_PAGES = 5;

/**
 * One cron step: file items for genuinely failed tasks of the lookback window that have none,
 * then close task items whose task is no longer failed (retried in place, or reset by a person).
 *
 * Budget (rule 47): indexed pages of failed tasks updated inside `inbox.errorLookbackMinutes`
 * (`idx_tasks_failed_updated`), newest first, `4 × inbox.errorSweepBatchSize` rows each, at most
 * `TASK_SWEEP_MAX_PAGES` pages; it stops early once `inbox.errorSweepBatchSize` items are filed
 * (about five D1 round trips each) or the window is exhausted; then one UPDATE for the closes,
 * driven from the tasks changed inside the window (`tasks(updated_at, id)`, then the unique
 * dedupe-key index). A candidate leaves the set once it has an item (the NOT EXISTS,
 * `idx_asks_error_task`) or once it ages out of the window. A failure a person set themselves is
 * excluded in SQL; the other normal endings (classified in code) are paged past. Throughput at the
 * defaults (batch 10, lookback 30 min, a tick every 5 min): 200 rows read and 10 items filed per tick, so normal
 * endings starve genuine failures only past 200 of them in 30 minutes, installation-wide, and a
 * filing backlog drains at 120 items an hour. A failure is filed within one tick (at most 5 min) of
 * being written, or at once by the VM-agent callback.
 */
export async function runInboxSystemErrorSweep(
  env: Env,
  now = Date.now()
): Promise<InboxSystemErrorSweepStats> {
  const deps = systemErrorDeps(env);
  const limits = await getInboxLimits(deps);
  const since = new Date(now - limits.errorLookbackMinutes * 60_000).toISOString();
  const pageSize = limits.errorSweepBatchSize * 4;
  let cursor: { updatedAt: string; id: string } | null = null;
  let scanned = 0;
  let filed = 0;
  let skippedNormal = 0;
  // Each half of this step is isolated (rule 53): a failed scan still lets the closes and the
  // undelivered-answer filing run.
  try {
    for (let page = 0; page < TASK_SWEEP_MAX_PAGES && filed < limits.errorSweepBatchSize; page++) {
      const candidates: { results?: Array<FailedTaskRow & { updated_at: string }> } =
        await env.DATABASE.prepare(
          `SELECT ${FAILED_TASK_COLUMNS}, t.updated_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.status = 'failed' AND t.updated_at > ?
            ${cursor ? 'AND (t.updated_at, t.id) < (?, ?)' : ''}
            -- Normal endings with no error (\`lifecycleOutcome\`) never fill the batch.
            AND t.error_message IS NOT NULL AND TRIM(t.error_message) != ''
            -- Nor one a person set themselves (\`classifyTaskFailure\` 'set_by_person').
            AND COALESCE((SELECT e.actor_type FROM task_status_events e
              WHERE e.task_id = t.id AND e.to_status = 'failed'
              ORDER BY e.created_at DESC LIMIT 1), '') != 'user'
            -- Not while its item is open or archived (key held): a later write to the failed
            -- task (an edit) is not another failure.
            AND NOT EXISTS (SELECT 1 FROM asks k
              WHERE k.project_id = t.project_id AND k.dedupe_key = 'error:task:' || t.id)
            -- Nor when an item was filed since the task last changed and has closed already
            -- (a retried task stays failed; its closed item must not be filed again).
            -- Only this task's own item (its first link is the task): a wake or sleep item of
            -- the task's chat carries the same source task.
            AND NOT EXISTS (SELECT 1 FROM asks a
              WHERE a.kind = 'error' AND a.source_task_id = t.id AND a.project_id = t.project_id
                AND a.links_json LIKE '[{"kind":"task","id":"' || t.id || '"%'
                AND a.created_at >= CAST((julianday(t.updated_at) - 2440587.5) * 86400000 AS INTEGER))
          ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`
        )
          .bind(since, ...(cursor ? [cursor.updatedAt, cursor.id] : []), pageSize)
          .all<FailedTaskRow & { updated_at: string }>();
      const rows = candidates.results ?? [];
      scanned += rows.length;
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
      const last = rows.at(-1);
      if (rows.length < pageSize || !last) break;
      cursor = { updatedAt: last.updated_at, id: last.id };
    }
  } catch (error) {
    log.error('inbox.system_error_scan_failed', serializeError(error));
  }

  // A task that left `failed` (retried in place, reset, or recovered) closes its item. Driven
  // from the tasks that changed inside the lookback window (`tasks(updated_at, id)`), not from
  // every held key, so the cost follows how often tasks change rather than how many items are
  // still open (rule 47). A task that recovers while this sweep is down for longer than the
  // window keeps its item open; Retry on it is then refused and the person archives it.
  let closed = 0;
  try {
    const result = await env.DATABASE.prepare(
      `UPDATE asks
          SET status = CASE WHEN status = 'open' THEN 'done' ELSE status END,
              answer_json = CASE WHEN status = 'open' THEN '{"resolution":"recovered"}' ELSE answer_json END,
              resolved_at = CASE WHEN status = 'open' THEN ? ELSE resolved_at END,
              notified_at = COALESCE(notified_at, ?), dedupe_key = NULL, updated_at = ?
        WHERE kind = 'error' AND status IN ('open', 'archived')
          AND (project_id, dedupe_key) IN (
            SELECT t.project_id, 'error:task:' || t.id FROM tasks t
             WHERE t.updated_at > ? AND t.status != 'failed')`
    )
      .bind(now, now, now, since)
      .run();
    closed = result.meta?.changes ?? 0;
  } catch (error) {
    log.error('inbox.system_error_close_failed', serializeError(error));
  }

  let undelivered = 0;
  try {
    undelivered = await fileUndeliveredAskAnswers(env, limits, now);
  } catch (error) {
    log.error('inbox.undelivered_answer_sweep_failed', serializeError(error));
  }

  const stats = { scanned, filed: filed + undelivered, skippedNormal, closed };
  if (stats.filed > 0 || stats.closed > 0) log.info('inbox.system_error_sweep', stats);
  return stats;
}

/**
 * A person answered, marked done or archived an ask from a chat, and the agent's notice was never
 * queued within `inbox.noticeRetryMinutes`: the inbox sweep (`sweep.ts`) has given up on it.
 * File one `delivery` error item per such ask for that person, linking the ask. Bounded: asks
 * that gave up inside the lookback window, at most `inbox.errorSweepBatchSize` per tick; an ask
 * leaves the set once an item links it (read on the project's asks, `idx_asks_project_status`,
 * only for the few candidates) or it ages out of the window.
 */
async function fileUndeliveredAskAnswers(
  env: Env,
  limits: Awaited<ReturnType<typeof getInboxLimits>>,
  now: number
): Promise<number> {
  const gaveUpBefore = now - limits.noticeRetryMinutes * 60_000;
  const result = await env.DATABASE.prepare(
    `SELECT a.id, a.project_id, a.source_session_id, a.resolved_by_user_id
       FROM asks a
      -- The status list is \`idx_asks_unnotified\`'s, term for term, so the index applies.
      WHERE a.notified_at IS NULL AND a.status IN ('answered', 'done', 'archived', 'expired')
        AND a.status != 'expired'
        -- An archived item owes the agent no notice (2026-11-17), so none is lost.
        AND a.status != 'archived'
        AND a.kind != 'error' AND a.source_session_id IS NOT NULL
        AND a.resolved_by_user_id IS NOT NULL
        AND a.resolved_at > ? AND a.resolved_at <= ?
        -- Not while the chat's delivery item (open or archived) was written after it was
        -- answered: one chat has one delivery item and a repeat filing rewrites its links, so a
        -- link alone would let two given-up asks swap the item every tick. A unique-index seek.
        AND NOT EXISTS (SELECT 1 FROM asks d
          WHERE d.project_id = a.project_id
            AND d.dedupe_key = 'error:delivery:' || a.source_session_id
            AND d.updated_at >= a.resolved_at)
        -- Nor once an item (since closed) linked it.
        AND NOT EXISTS (SELECT 1 FROM asks e
          WHERE e.kind = 'error' AND e.project_id = a.project_id
            AND e.links_json LIKE '%"kind":"ask","id":"' || a.id || '"%')
      ORDER BY a.resolved_at LIMIT ?`
  )
    .bind(
      gaveUpBefore - limits.errorLookbackMinutes * 60_000,
      gaveUpBefore,
      limits.errorSweepBatchSize
    )
    .all<{
      id: string;
      project_id: string;
      source_session_id: string;
      resolved_by_user_id: string;
    }>();
  let filed = 0;
  for (const row of result.results ?? []) {
    let chat: Awaited<ReturnType<typeof loadChatForError>>;
    try {
      chat = await loadChatForError(env, row.project_id, row.source_session_id);
    } catch {
      continue; // Unreadable now; the next tick tries again inside the window.
    }
    // An archived chat (or one that no longer exists) is a normal ending: nothing to tell.
    if (!chat) continue;
    const filedItem = await fileAndNotify(env, {
      projectId: row.project_id,
      assigneeUserId: row.resolved_by_user_id,
      source: 'delivery',
      subjectId: row.source_session_id,
      title: `Your answer didn't reach the agent in ${quotedName(chat.topic, 'a chat')}`,
      body: 'SAM kept trying but could not hand your answer to the agent; open the chat and tell it again if it still needs it.',
      actions: ['open_chat'],
      sourceTaskId: chat.taskId,
      sourceSessionId: row.source_session_id,
      links: [
        { kind: 'chat', id: row.source_session_id, label: null },
        { kind: 'ask', id: row.id, label: null },
      ],
    });
    if (filedItem) filed += 1;
  }
  return filed;
}

/**
 * A chat as an error item names it: its task, topic and creator. Reads the D1 chat index first
 * and falls back to the ProjectData session when the index has not synced the chat yet.
 */
export async function loadChatForError(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<{ taskId: string | null; topic: string | null; createdBy: string | null } | null> {
  const row = await env.DATABASE.prepare(
    `SELECT ss.task_id, ss.topic, ss.created_by_user_id, ss.status,
        (SELECT t.id FROM tasks t WHERE t.project_id = ss.project_id AND t.chat_session_id = ss.id)
          AS bound_task_id
       FROM session_summaries ss WHERE ss.id = ? AND ss.project_id = ?`
  )
    .bind(sessionId, projectId)
    .first<{
      task_id: string | null;
      topic: string | null;
      created_by_user_id: string | null;
      status: string | null;
      bound_task_id: string | null;
    }>();
  // An archived chat is a normal ending: it files nothing (policy a974b04f).
  if (row?.status === 'archived') return null;
  if (row) {
    return {
      // `createAsk` requires the chat to be the task's own; prefer the task bound to it now.
      taskId: row.bound_task_id ?? row.task_id,
      topic: row.topic,
      createdBy: row.created_by_user_id,
    };
  }
  const session = await projectDataService.getSession(env, projectId, sessionId);
  if (!session || session.status === 'archived') return null;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const bound = await env.DATABASE.prepare(
    'SELECT id FROM tasks WHERE project_id = ? AND chat_session_id = ?'
  )
    .bind(projectId, sessionId)
    .first<{ id: string }>();
  return {
    taskId: bound?.id ?? text(session.taskId),
    topic: text(session.topic),
    createdBy: text(session.createdByUserId),
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
    if (!chat) return null;
    const name = quotedName(chat.topic, 'A chat');
    return await fileAndNotify(env, {
      projectId: input.projectId,
      assigneeUserId: chat.createdBy ?? input.userId,
      source: 'sleep',
      subjectId: input.sessionId,
      title: `${name} went to sleep without saving its latest work`,
      body: input.exactRestore
        ? 'SAM could not save a fresh snapshot, so it slept the chat from its last complete one; changes made after that snapshot may be lost.'
        : 'SAM could not save a snapshot before it shut the workspace down, so unsaved files and uncommitted work may be lost.',
      actions: ['open_chat'],
      sourceTaskId: chat.taskId,
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
 * `delivery_unconfirmed`). One item per chat. Returns `skipped` for a chat that files nothing (an
 * archived chat, no recorded creator) and `failed` when the item could not be written, so the
 * caller's outbox job can retry instead of losing it. Never throws.
 */
export async function fileUndeliveredAnswerError(
  env: Env,
  input: { projectId: string; sessionId: string }
): Promise<'filed' | 'skipped' | 'failed'> {
  try {
    const chat = await loadChatForError(env, input.projectId, input.sessionId);
    if (!chat?.createdBy) return 'skipped';
    const name = quotedName(chat.topic, 'a chat');
    const filed = await fileAndNotify(env, {
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
    return filed ? 'filed' : 'failed';
  } catch (error) {
    log.error('inbox.undelivered_answer_file_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      ...serializeError(error),
    });
    return 'failed';
  }
}
