import { TASK_TERMINAL_STATUSES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { parseRowOrNull } from '../row-validation';
import {
  CANDIDATE_GATE_META_PREFIX,
  claimReconciliationCandidate,
  clearReconciliationCandidateGate,
  deferReconciliationCandidateUntil,
  excludeReconciliationCandidateForTask,
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
  const cursorActivity = cursor?.lastActivityAt ?? null;
  const cursorSessionId = cursor?.sessionId ?? null;
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
         LEFT JOIN do_meta gate ON gate.key = ? || cs.id
         WHERE cs.status = 'active'
           AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
           AND COALESCE(ics.workspace_id, cs.workspace_id) IS NOT NULL
           AND CASE
             WHEN gate.value IS NULL OR json_valid(gate.value) = 0 THEN 1
             ELSE COALESCE(
               json_extract(gate.value, '$.excludedTaskId') != COALESCE(ics.task_id, cs.task_id),
               1
             )
           END
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
         AND (
           ? IS NULL
           OR last_activity_at > ?
           OR (last_activity_at = ? AND session_id > ?)
         )
       ORDER BY last_activity_at ASC, session_id ASC
       LIMIT ?`,
      CANDIDATE_GATE_META_PREFIX,
      idleThreshold,
      cursorActivity,
      cursorActivity,
      cursorActivity,
      cursorSessionId,
      candidateLimit
    )
    .toArray() as unknown as LocalCandidateRow[];
}

interface CandidateBuildInput {
  sql: SqlStorage;
  env: Env;
  row: LocalCandidateRow;
  now: number;
  softPromptMs: number;
  hardPromptMs: number;
}

interface CandidateBuildResult {
  candidate: ReconciliationCandidate | null;
}

async function resolveCandidateProjectId(
  env: Env,
  sessionId: string,
  workspaceId: string,
  taskId: string,
  sql: SqlStorage
): Promise<string | null> {
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
  if (!taskRow) {
    recordReconciliationCandidateInconclusive(sql, env, {
      sessionId,
      workspaceId,
      taskId,
      reason: 'task_missing',
    });
    return null;
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
    return null;
  }
  if (
    taskRow.task_mode !== 'task' ||
    (TASK_TERMINAL_STATUSES as readonly string[]).includes(taskRow.status)
  ) {
    excludeReconciliationCandidateForTask(sql, sessionId, taskId);
    return null;
  }
  if (!['in_progress', 'delegated', 'awaiting_followup'].includes(taskRow.status)) {
    recordReconciliationCandidateInconclusive(sql, env, {
      sessionId,
      workspaceId,
      taskId,
      reason: 'task_not_active',
    });
    return null;
  }
  return taskRow.project_id;
}

function resolveAcpSessionId(
  sql: SqlStorage,
  env: Env,
  workspaceId: string,
  sessionId: string,
  taskId: string
): string | null {
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
    return null;
  }
  return acpRow.id;
}

function resolvePromptAction(
  sql: SqlStorage,
  sessionId: string,
  acpSessionId: string,
  lastActivityAt: number,
  now: number,
  softPromptMs: number,
  hardPromptMs: number
): {
  action: ReconciliationCandidate['action'];
  promptStartedAt: number;
  promptAgeMs: number;
} | null {
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
  if (stateRow?.activity !== 'prompting') {
    return { action: 'checkin', promptStartedAt: 0, promptAgeMs: 0 };
  }
  const promptStartedAt = stateRow.prompt_started_at || stateRow.activity_at || lastActivityAt;
  const promptAgeMs = Math.max(0, now - promptStartedAt);
  if (promptAgeMs < softPromptMs) {
    deferReconciliationCandidateUntil(sql, sessionId, promptStartedAt + softPromptMs);
    return null;
  }
  const action = promptAgeMs >= hardPromptMs ? 'cancel_prompt' : 'observe_prompt';
  return { action, promptStartedAt, promptAgeMs };
}

async function buildCandidate(input: CandidateBuildInput): Promise<CandidateBuildResult> {
  const { sql, env, row, now, softPromptMs, hardPromptMs } = input;
  if (
    typeof row.session_id !== 'string' ||
    typeof row.workspace_id !== 'string' ||
    typeof row.task_id !== 'string' ||
    typeof row.last_activity_at !== 'number'
  ) {
    if (typeof row.session_id === 'string') {
      clearReconciliationCandidateGate(sql, row.session_id);
    }
    return { candidate: null };
  }
  const sessionId = row.session_id;
  const workspaceId = row.workspace_id;
  const taskId = row.task_id;
  const lastActivityAt = row.last_activity_at;

  let projectId: string | null = null;
  try {
    projectId = await resolveCandidateProjectId(env, sessionId, workspaceId, taskId, sql);
  } catch (err) {
    log.warn('reconciliation.d1_task_query_failed', { taskId, ...serializeError(err) });
    recordReconciliationCandidateInconclusive(sql, env, {
      sessionId,
      workspaceId,
      taskId,
      reason: 'd1_task_query_failed',
    });
    return { candidate: null };
  }
  if (!projectId) return { candidate: null };

  const acpSessionId = resolveAcpSessionId(sql, env, workspaceId, sessionId, taskId);
  if (!acpSessionId) return { candidate: null };

  const promptResult = resolvePromptAction(
    sql,
    sessionId,
    acpSessionId,
    lastActivityAt,
    now,
    softPromptMs,
    hardPromptMs
  );
  if (!promptResult) return { candidate: null };

  return {
    candidate: {
      sessionId,
      workspaceId,
      taskId,
      projectId,
      acpSessionId,
      lastActivityAt,
      idleDurationMs: now - lastActivityAt,
      action: promptResult.action,
      promptStartedAt: promptResult.action === 'checkin' ? null : promptResult.promptStartedAt,
      promptAgeMs: promptResult.action === 'checkin' ? null : promptResult.promptAgeMs,
    },
  };
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
      typeof row.task_id === 'string' &&
      claimReconciliationCandidate(sql, row.session_id, row.task_id, {
        now,
        leaseMs,
        maxAttempts,
      })
  );

  const candidates: ReconciliationCandidate[] = [];
  for (const row of claimedRows) {
    const { candidate } = await buildCandidate({
      sql,
      env,
      row,
      now,
      softPromptMs,
      hardPromptMs,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}
