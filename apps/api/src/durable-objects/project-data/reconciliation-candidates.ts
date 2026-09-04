import * as v from 'valibot';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { parseRowOrNull } from '../row-validation';
import {
  claimReconciliationCandidate,
  clearReconciliationCandidateGate,
  deferReconciliationCandidateUntil,
  readReconciliationCursor,
  type ReconciliationCursor,
  recordReconciliationCandidateInconclusive,
  resetReconciliationCursor,
  writeReconciliationCursor,
} from './reconciliation-candidate-state';
import {
  maxCandidatesPerSweep,
  promptHardStallMs,
  promptSoftStallMs,
  reconciliationCandidateLeaseMs,
  reconciliationIdleMs,
  reconciliationProbeMaxAttempts,
} from './reconciliation-thresholds';
import type { Env } from './types';

const log = createModuleLogger('reconciliation');

export interface ReconciliationCandidate {
  sessionId: string;
  workspaceId: string;
  taskId: string;
  projectId: string;
  acpSessionId: string;
  lastActivityAt: number;
  idleDurationMs: number;
  action: 'checkin' | 'observe_prompt' | 'cancel_prompt';
  promptStartedAt: number | null;
  promptAgeMs: number | null;
}

const SessionStateRowSchema = v.object({
  activity: v.nullable(v.string()),
  activity_at: v.nullable(v.number()),
  prompt_started_at: v.nullable(v.number()),
});

interface LocalCandidateRow {
  session_id: unknown;
  workspace_id: unknown;
  task_id: unknown;
  last_activity_at: unknown;
}

function selectLocalCandidatePage(
  sql: SqlStorage,
  idleThreshold: number,
  candidateLimit: number,
  cursor: ReconciliationCursor | null
): LocalCandidateRow[] {
  const cursorClause = cursor
    ? `AND (
         last_activity_at > ?
         OR (last_activity_at = ? AND session_id > ?)
       )`
    : '';
  const cursorParams = cursor
    ? [cursor.lastActivityAt, cursor.lastActivityAt, cursor.sessionId]
    : [];
  return sql
    .exec(
      `WITH local_candidates AS (
         SELECT
           cs.id AS session_id,
           COALESCE(ics.workspace_id, cs.workspace_id) AS workspace_id,
           COALESCE(ics.task_id, cs.task_id) AS task_id,
           COALESCE(
             CASE
               WHEN wa.last_message_at IS NULL THEN wa.last_terminal_activity_at
               WHEN wa.last_terminal_activity_at IS NULL THEN wa.last_message_at
               WHEN wa.last_terminal_activity_at > wa.last_message_at THEN wa.last_terminal_activity_at
               ELSE wa.last_message_at
             END,
             wa.created_at,
             cs.updated_at,
             cs.created_at,
             ics.created_at
           ) AS last_activity_at
         FROM chat_sessions cs
         LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
         LEFT JOIN workspace_activity wa
           ON wa.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
         WHERE cs.status = 'active'
           AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
           AND COALESCE(ics.workspace_id, cs.workspace_id) IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM session_attention_markers sam
             WHERE sam.session_id = cs.id
               AND sam.resolved_at IS NULL
               AND sam.kind IN ('needs_input', 'reconciliation_checkin')
           )
       )
       SELECT session_id, workspace_id, task_id, last_activity_at
       FROM local_candidates
       WHERE last_activity_at <= ?
       ${cursorClause}
       ORDER BY last_activity_at ASC, session_id ASC
       LIMIT ?`,
      idleThreshold,
      ...cursorParams,
      candidateLimit
    )
    .toArray() as unknown as LocalCandidateRow[];
}

/**
 * Find and durably claim a bounded page of task-mode sessions eligible for
 * reconciliation. D1 is consulted only after the DO-local cursor and leases
 * have been advanced synchronously.
 */
export async function getReconciliationCandidates(
  sql: SqlStorage,
  env: Env
): Promise<ReconciliationCandidate[]> {
  const now = Date.now();
  const idleThreshold = now - reconciliationIdleMs(env);
  const softPromptMs = promptSoftStallMs(env);
  const hardPromptMs = promptHardStallMs(env);
  const candidateLimit = maxCandidatesPerSweep(env);
  const leaseMs = reconciliationCandidateLeaseMs(env);
  const maxAttempts = reconciliationProbeMaxAttempts(env);

  let cursor = readReconciliationCursor(sql);
  let rows = selectLocalCandidatePage(sql, idleThreshold, candidateLimit, cursor);
  if (rows.length === 0 && cursor) {
    resetReconciliationCursor(sql);
    cursor = null;
    rows = selectLocalCandidatePage(sql, idleThreshold, candidateLimit, null);
  }
  const lastRow = rows.at(-1);
  if (
    lastRow &&
    typeof lastRow.last_activity_at === 'number' &&
    typeof lastRow.session_id === 'string'
  ) {
    writeReconciliationCursor(sql, {
      lastActivityAt: lastRow.last_activity_at,
      sessionId: lastRow.session_id,
    });
  }
  const claimedRows = rows.filter(
    (row) =>
      typeof row.session_id === 'string' &&
      claimReconciliationCandidate(sql, row.session_id, { now, leaseMs, maxAttempts })
  );
  const candidates: ReconciliationCandidate[] = [];

  for (const row of claimedRows) {
    if (
      typeof row.session_id !== 'string' ||
      typeof row.workspace_id !== 'string' ||
      typeof row.task_id !== 'string' ||
      typeof row.last_activity_at !== 'number'
    ) {
      if (typeof row.session_id === 'string') {
        clearReconciliationCandidateGate(sql, row.session_id);
      }
      continue;
    }
    const sessionId = row.session_id;
    const workspaceId = row.workspace_id;
    const taskId = row.task_id;
    const lastActivityAt = row.last_activity_at;
    let projectId: string | null = null;

    try {
      const taskRow = await env.DATABASE.prepare(
        `SELECT task_mode, status, project_id, workspace_id, chat_session_id
         FROM tasks WHERE id = ? LIMIT 1`
      )
        .bind(taskId)
        .first<{
          task_mode: string | null;
          status: string;
          project_id: string | null;
          workspace_id: string | null;
          chat_session_id: string | null;
        }>();
      if (
        !taskRow ||
        taskRow.task_mode !== 'task' ||
        !['in_progress', 'delegated', 'awaiting_followup'].includes(taskRow.status)
      ) {
        clearReconciliationCandidateGate(sql, sessionId);
        continue;
      }
      if (
        !taskRow.project_id ||
        taskRow.workspace_id !== workspaceId ||
        taskRow.chat_session_id !== sessionId
      ) {
        recordReconciliationCandidateInconclusive(sql, env, {
          sessionId,
          workspaceId,
          taskId,
          reason: 'task_identity_mismatch',
        });
        continue;
      }
      projectId = taskRow.project_id;
    } catch (err) {
      log.warn('reconciliation.d1_task_query_failed', { taskId, ...serializeError(err) });
      recordReconciliationCandidateInconclusive(sql, env, {
        sessionId,
        workspaceId,
        taskId,
        reason: 'd1_task_query_failed',
      });
      continue;
    }
    if (!projectId) continue;

    const acpRow = sql
      .exec(
        `SELECT id FROM acp_sessions
         WHERE workspace_id = ? AND chat_session_id = ? AND status IN ('assigned', 'running')
         ORDER BY created_at DESC LIMIT 1`,
        workspaceId,
        sessionId
      )
      .toArray()[0];
    if (typeof acpRow?.id !== 'string') {
      log.warn('reconciliation.no_active_acp_session', { sessionId, workspaceId });
      recordReconciliationCandidateInconclusive(sql, env, {
        sessionId,
        workspaceId,
        taskId,
        reason: 'active_acp_session_missing',
      });
      continue;
    }

    const acpSessionId = acpRow.id;
    const stateRow = parseRowOrNull(
      sql
        .exec(
          `SELECT activity, activity_at, prompt_started_at FROM session_state WHERE session_id = ?`,
          acpSessionId
        )
        .toArray()[0],
      SessionStateRowSchema,
      'reconciliation.session_state'
    );
    let action: ReconciliationCandidate['action'] = 'checkin';
    let promptStartedAt: number | null = null;
    let promptAgeMs: number | null = null;

    if (stateRow?.activity === 'prompting') {
      promptStartedAt = stateRow.prompt_started_at || stateRow.activity_at || lastActivityAt;
      promptAgeMs = Math.max(0, now - promptStartedAt);
      if (promptAgeMs < softPromptMs) {
        deferReconciliationCandidateUntil(sql, sessionId, promptStartedAt + softPromptMs);
        continue;
      }
      action = promptAgeMs >= hardPromptMs ? 'cancel_prompt' : 'observe_prompt';
    }

    candidates.push({
      sessionId,
      workspaceId,
      taskId,
      projectId,
      acpSessionId,
      lastActivityAt,
      idleDurationMs: now - lastActivityAt,
      action,
      promptStartedAt,
      promptAgeMs,
    });
  }
  return candidates;
}
