/**
 * Task-mode inactivity reconciliation — SAM check-in for silent agents.
 *
 * When a task-mode agent goes idle (no messages, tool calls, or status
 * updates) for TASK_RECONCILIATION_IDLE_MS, SAM sends a visible check-in
 * prompt. If the agent does not respond within the deadline, the task is
 * failed and cleaned up.
 *
 * Exclusions:
 * - Conversation-mode tasks (handled by workspace idle timeout)
 * - Tasks already completed/failed/cancelled
 * - Sessions with active `needs_input` attention markers
 * - Sessions that already have an unresolved `reconciliation_checkin` marker
 */
import {
  DEFAULT_TASK_RECONCILIATION_IDLE_MS,
  DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS,
} from '@simple-agent-manager/shared';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger, serializeError } from '../../lib/logger';
import { sendPromptToAgentOnNode } from '../../services/node-agent';
import { recordActivityEventInternal } from './activity';
import { createAttentionMarker } from './attention';
import { persistMessage } from './messages';
import type { Env as DOEnv } from './types';

const log = createModuleLogger('reconciliation');

/** The check-in prompt sent to the agent. */
const CHECKIN_PROMPT =
  '[SAM Orchestrator Check-In] Your task appears to have stalled — no activity detected for several minutes. ' +
  'Please respond with a progress update. If you are finished, call complete_task(). ' +
  'If you need human help, call request_human_input(). ' +
  'If you do not respond shortly, this task will be marked as failed.';

/** Source metadata attached to the persisted check-in message. */
const CHECKIN_METADATA = JSON.stringify({ source: 'sam_orchestrator', kind: 'reconciliation_checkin' });

export interface ReconciliationCandidate {
  sessionId: string;
  workspaceId: string;
  taskId: string;
  acpSessionId: string;
  lastActivityAt: number;
  idleDurationMs: number;
}

/**
 * Find task-mode sessions that are idle and eligible for a SAM check-in.
 *
 * A session is a candidate if:
 * 1. It is an active chat session linked to a task and workspace
 * 2. The session has been idle for at least TASK_RECONCILIATION_IDLE_MS
 * 3. There is no active `needs_input` attention marker
 * 4. There is no unresolved `reconciliation_checkin` attention marker
 * 5. The task is still active in D1 and task_mode = 'task'
 */
export async function getReconciliationCandidates(
  sql: SqlStorage,
  env: DOEnv,
): Promise<ReconciliationCandidate[]> {
  const now = Date.now();
  const idleThresholdMs = Number.parseInt(
    (env as unknown as Record<string, string | undefined>).TASK_RECONCILIATION_IDLE_MS ?? '',
    10,
  ) || DEFAULT_TASK_RECONCILIATION_IDLE_MS;
  const idleThreshold = now - idleThresholdMs;

  // Find active task-linked sessions. idle_cleanup_schedule is optional: early
  // production task sessions predated reliable schedule creation, and
  // reconciliation must still protect them.
  // Join with workspace_activity to get last activity timestamp.
  // Exclude sessions that already have active needs_input or reconciliation_checkin markers.
  const rows = sql.exec(
    `SELECT
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
     LEFT JOIN workspace_activity wa ON wa.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
     WHERE cs.status = 'active'
       AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
       AND COALESCE(ics.workspace_id, cs.workspace_id) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM session_attention_markers sam
         WHERE sam.session_id = cs.id
           AND sam.resolved_at IS NULL
           AND sam.kind IN ('needs_input', 'reconciliation_checkin')
       )`,
  ).toArray();

  const candidates: ReconciliationCandidate[] = [];

  for (const row of rows) {
    const sessionId = row.session_id as string;
    const workspaceId = row.workspace_id as string;
    const taskId = row.task_id as string;
    const lastActivityAt = (row.last_activity_at as number) || 0;

    // Check if the session has been idle long enough
    if (lastActivityAt > idleThreshold) continue;

    // Verify task is still active and task_mode = 'task' via D1
    try {
      const taskRow = await env.DATABASE.prepare(
        `SELECT task_mode, status FROM tasks WHERE id = ? LIMIT 1`,
      ).bind(taskId).first<{ task_mode: string | null; status: string }>();

      if (!taskRow) continue;
      if (taskRow.task_mode !== 'task') continue;
      if (!['in_progress', 'delegated', 'awaiting_followup'].includes(taskRow.status)) continue;
    } catch (err) {
      log.warn('reconciliation.d1_task_query_failed', { taskId, ...serializeError(err) });
      continue;
    }

    // Find active ACP session for this workspace (DO SQLite)
    const acpRows = sql.exec(
      `SELECT id FROM acp_sessions
       WHERE workspace_id = ? AND status IN ('running', 'started')
       ORDER BY created_at DESC LIMIT 1`,
      workspaceId,
    ).toArray();

    const acpRow = acpRows[0];
    if (!acpRow?.id) {
      log.warn('reconciliation.no_active_acp_session', { sessionId, workspaceId });
      continue;
    }

    candidates.push({
      sessionId,
      workspaceId,
      taskId,
      acpSessionId: acpRow.id as string,
      lastActivityAt,
      idleDurationMs: now - lastActivityAt,
    });
  }

  return candidates;
}

/**
 * Process reconciliation candidates — send check-in messages and create
 * response deadline markers.
 */
export async function processReconciliationCandidates(
  sql: SqlStorage,
  env: DOEnv,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
): Promise<number> {
  const candidates = await getReconciliationCandidates(sql, env);
  if (candidates.length === 0) return 0;

  const deadlineMs = Number.parseInt(
    (env as unknown as Record<string, string | undefined>).TASK_RECONCILIATION_RESPONSE_DEADLINE_MS ?? '',
    10,
  ) || DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS;

  let processed = 0;

  for (const candidate of candidates) {
    try {
      // 1. Persist the check-in as a user-role message with SAM metadata
      const msgResult = persistMessage(
        sql, env, candidate.sessionId, 'user', CHECKIN_PROMPT, CHECKIN_METADATA,
      );

      // 2. Create a reconciliation_checkin attention marker with deadline expiry
      const marker = createAttentionMarker(sql, {
        sessionId: candidate.sessionId,
        taskId: candidate.taskId,
        workspaceId: candidate.workspaceId,
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        sourceMessageId: msgResult.id,
        reason: `Agent idle for ${Math.round(candidate.idleDurationMs / 1000)}s — SAM check-in sent`,
        expiresAt: Date.now() + deadlineMs,
      });

      // 3. Send the prompt to the VM agent (best-effort — if the agent is
      //    unreachable, the deadline marker will still fire and fail the task)
      try {
        await sendCheckinToAgent(env, candidate);
      } catch (err) {
        log.warn('reconciliation.send_prompt_failed', {
          sessionId: candidate.sessionId,
          workspaceId: candidate.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't abort — the attention marker deadline will handle the failure
      }

      // 4. Record activity event
      recordActivityEventInternal(
        sql,
        'reconciliation.checkin_sent',
        'system',
        null,
        candidate.workspaceId,
        candidate.sessionId,
        candidate.taskId,
        JSON.stringify({
          messageId: msgResult.id,
          markerId: marker.id,
          idleDurationMs: candidate.idleDurationMs,
          deadlineMs,
        }),
      );

      broadcastEvent('message.new', {
        sessionId: candidate.sessionId,
        messageId: msgResult.id,
        role: 'user',
        content: CHECKIN_PROMPT,
        toolMetadata: JSON.parse(CHECKIN_METADATA),
        createdAt: msgResult.now,
        sequence: msgResult.sequence,
      }, candidate.sessionId);

      broadcastEvent('attention.created', {
        sessionId: candidate.sessionId,
        markerId: marker.id,
        kind: 'reconciliation_checkin',
      }, candidate.sessionId);

      log.info('reconciliation.checkin_sent', {
        sessionId: candidate.sessionId,
        taskId: candidate.taskId,
        workspaceId: candidate.workspaceId,
        markerId: marker.id,
        messageId: msgResult.id,
        idleDurationMs: candidate.idleDurationMs,
      });

      processed++;
    } catch (err) {
      log.error('reconciliation.checkin_failed', {
        sessionId: candidate.sessionId,
        taskId: candidate.taskId,
        ...serializeError(err),
      });
    }
  }

  return processed;
}

/**
 * Send the check-in prompt to the VM agent via the node agent service.
 * This requires the full Worker env for JWT signing and node routing.
 */
async function sendCheckinToAgent(
  env: DOEnv,
  candidate: ReconciliationCandidate,
): Promise<void> {
  const workerEnv = env as unknown as WorkerEnv;

  // Look up node_id and user_id from the workspace in D1
  const wsRow = await workerEnv.DATABASE.prepare(
    'SELECT node_id, user_id FROM workspaces WHERE id = ?',
  ).bind(candidate.workspaceId).first<{ node_id: string | null; user_id: string }>();

  if (!wsRow?.node_id) {
    log.warn('reconciliation.workspace_missing_node', {
      workspaceId: candidate.workspaceId,
    });
    return;
  }

  await sendPromptToAgentOnNode(
    wsRow.node_id,
    candidate.workspaceId,
    candidate.acpSessionId,
    CHECKIN_PROMPT,
    workerEnv,
    wsRow.user_id,
  );
}

/**
 * Compute the next alarm time for reconciliation checks.
 *
 * Looks at active task-linked sessions and returns when the next reconciliation
 * check should fire. Task mode is verified when processing candidates; this
 * alarm calculation intentionally stays DO-local.
 */
export function computeReconciliationAlarmTime(
  sql: SqlStorage,
  env: DOEnv,
): number | null {
  const idleThresholdMs = Number.parseInt(
    (env as unknown as Record<string, string | undefined>).TASK_RECONCILIATION_IDLE_MS ?? '',
    10,
  ) || DEFAULT_TASK_RECONCILIATION_IDLE_MS;

  // Find the earliest activity among active task-linked sessions that don't
  // have an active reconciliation or needs_input marker. Join active ACP
  // sessions so old active chat rows without a running agent do not keep the
  // ProjectData alarm hot forever.
  const rows = sql.exec(
    `SELECT
       MIN(COALESCE(
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
       )) AS earliest_activity
     FROM chat_sessions cs
     LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
     LEFT JOIN workspace_activity wa ON wa.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
     WHERE cs.status = 'active'
       AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
       AND COALESCE(ics.workspace_id, cs.workspace_id) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM acp_sessions acp
         WHERE acp.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
           AND acp.status IN ('running', 'started')
       )
       AND NOT EXISTS (
         SELECT 1 FROM session_attention_markers sam
         WHERE sam.session_id = cs.id
           AND sam.resolved_at IS NULL
           AND sam.kind IN ('needs_input', 'reconciliation_checkin')
       )`,
  ).toArray();

  const row = rows[0];
  if (row?.earliest_activity === null || row?.earliest_activity === undefined) {
    return null;
  }

  const earliestActivity = row.earliest_activity as number;
  const nextCheck = earliestActivity + idleThresholdMs;

  // Ensure we don't schedule in the past — at minimum 10s in the future
  return Math.max(nextCheck, Date.now() + 10_000);
}
