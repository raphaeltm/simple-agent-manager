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
  DEFAULT_TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_TASK_RECONCILIATION_MIN_ALARM_DELAY_MS,
  DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS,
  DEFAULT_TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS,
  DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS,
  DEFAULT_TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS,
  DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS,
} from '@simple-agent-manager/shared';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger, serializeError } from '../../lib/logger';
import { cancelAgentSessionOnNode, sendPromptToAgentOnNode } from '../../services/node-agent';
import { recordActivityEventInternal } from './activity';
import { createAttentionMarker } from './attention';
import { persistMessage } from './messages';
import {
  type ReconciliationProcessingHooks,
  terminallyFailDeadTarget,
} from './reconciliation-dead-target';
import { upsertActivityState } from './session-state';
import type { Env as DOEnv } from './types';

const log = createModuleLogger('reconciliation');

/** The check-in prompt sent to the agent. */
const CHECKIN_PROMPT =
  '[SAM Orchestrator Check-In] Your task appears to have stalled — no activity detected for several minutes. ' +
  'Please send a brief progress update, then continue working from where you left off if there is still work to do. ' +
  'Do not stop after the update unless you are finished or need human help. If you are finished, call complete_task(). ' +
  'If you need human help, call request_human_input(). ' +
  'If you do not respond shortly, this task will be marked as failed.';

/** Source metadata attached to the persisted check-in message. */
const CHECKIN_METADATA = JSON.stringify({
  source: 'sam_orchestrator',
  kind: 'reconciliation_checkin',
});
const RECOVERY_CHECKIN_METADATA = JSON.stringify({
  source: 'sam_orchestrator',
  kind: 'reconciliation_checkin',
  recovery: 'conversation_error',
});

const RECOVERY_ERROR_DETAIL_MAX_CHARS = 500;
const REDACTED_DIAGNOSTIC_VALUE = '[REDACTED]';

export interface ReconciliationCandidate {
  sessionId: string;
  workspaceId: string;
  taskId: string;
  acpSessionId: string;
  lastActivityAt: number;
  idleDurationMs: number;
  action: 'checkin' | 'observe_prompt' | 'cancel_prompt' | 'recovery_checkin';
  promptStartedAt: number | null;
  promptAgeMs: number | null;
  recoveryErrorMessage: string | null;
}

interface SessionStateRow {
  activity: string | null;
  activity_at: number | null;
  prompt_started_at: number | null;
}

interface TaskRow {
  task_mode: string | null;
  status: string;
  error_message?: string | null;
}

interface RecoverableErrorEvent {
  createdAt: number;
  errorMessage: string | null;
}

interface WorkspaceDeliveryTarget {
  nodeId: string;
  userId: string;
}

type WorkspaceDeliveryTargetResult =
  | { ok: true; target: WorkspaceDeliveryTarget }
  | {
      ok: false;
      reason: string;
      nodeId: string | null;
      userId: string | null;
      projectId: string | null;
    };

function envNumber(env: DOEnv, key: string, fallback: number): number {
  const value = Number.parseInt(
    (env as unknown as Record<string, string | undefined>)[key] ?? '',
    10
  );
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function reconciliationIdleMs(env: DOEnv): number {
  return envNumber(env, 'TASK_RECONCILIATION_IDLE_MS', DEFAULT_TASK_RECONCILIATION_IDLE_MS);
}

function reconciliationDeadlineMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_RESPONSE_DEADLINE_MS',
    DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS
  );
}

function promptSoftStallMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS',
    DEFAULT_TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS
  );
}

function promptHardStallMs(env: DOEnv): number {
  const softMs = promptSoftStallMs(env);
  const hardMs = envNumber(
    env,
    'TASK_RECONCILIATION_PROMPT_HARD_STALL_MS',
    DEFAULT_TASK_RECONCILIATION_PROMPT_HARD_STALL_MS
  );
  return Math.max(hardMs, softMs);
}

function minReconciliationAlarmDelayMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_MIN_ALARM_DELAY_MS',
    DEFAULT_TASK_RECONCILIATION_MIN_ALARM_DELAY_MS
  );
}

function maxCandidatesPerSweep(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP',
    DEFAULT_TASK_RECONCILIATION_MAX_CANDIDATES_PER_SWEEP
  );
}

function nodeHeartbeatStaleMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS',
    DEFAULT_TASK_RECONCILIATION_NODE_HEARTBEAT_STALE_MS
  );
}

function reconciliationNodeCallTimeoutMs(env: DOEnv): number {
  return envNumber(
    env,
    'TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS',
    DEFAULT_TASK_RECONCILIATION_NODE_CALL_TIMEOUT_MS
  );
}

/**
 * Find task sessions that are idle and eligible for a SAM check-in.
 *
 * A session is a candidate if:
 * 1. It is an active chat session linked to a task and workspace
 * 2. The session has been idle for at least TASK_RECONCILIATION_IDLE_MS
 * 3. There is no active `needs_input` attention marker
 * 4. There is no unresolved `reconciliation_checkin` attention marker
 * 5. The task is still active in D1
 * 6. Either task_mode = 'task', or task_mode = 'conversation' with a
 *    recoverable agent error and no later activity.
 */
export async function getReconciliationCandidates(
  sql: SqlStorage,
  env: DOEnv
): Promise<ReconciliationCandidate[]> {
  const now = Date.now();
  const idleThresholdMs = reconciliationIdleMs(env);
  const idleThreshold = now - idleThresholdMs;
  const softPromptMs = promptSoftStallMs(env);
  const hardPromptMs = promptHardStallMs(env);

  // Find active task-linked sessions. idle_cleanup_schedule is optional: early
  // production task sessions predated reliable schedule creation, and
  // reconciliation must still protect them.
  // Join with workspace_activity to get last activity timestamp.
  // Exclude sessions that already have active needs_input or reconciliation_checkin markers.
  const rows = sql
    .exec(
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
       )`
    )
    .toArray();

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
        `SELECT task_mode, status, error_message FROM tasks WHERE id = ? LIMIT 1`
      )
        .bind(taskId)
        .first<TaskRow>();

      if (!taskRow) continue;
      if (!['in_progress', 'delegated', 'awaiting_followup'].includes(taskRow.status)) continue;

      if (taskRow.task_mode === 'task') {
        // Task-mode sessions use the normal check-in path.
      } else if (taskRow.task_mode === 'conversation') {
        const recoverableError = getLatestRecoverableErrorEvent(
          sql,
          sessionId,
          taskId,
          taskRow.error_message ?? null
        );
        if (!recoverableError?.errorMessage) continue;
        if (lastActivityAt > recoverableError.createdAt) continue;
        const recoveryCandidate = buildCandidateForActiveSession(sql, env, {
          sessionId,
          workspaceId,
          taskId,
          lastActivityAt,
          action: 'recovery_checkin',
          recoveryErrorMessage: recoverableError.errorMessage,
        });
        if (recoveryCandidate) candidates.push(recoveryCandidate);
        continue;
      } else {
        continue;
      }
    } catch (err) {
      log.warn('reconciliation.d1_task_query_failed', { taskId, ...serializeError(err) });
      continue;
    }

    const candidate = buildCandidateForActiveSession(sql, env, {
      sessionId,
      workspaceId,
      taskId,
      lastActivityAt,
      action: 'checkin',
      recoveryErrorMessage: null,
      softPromptMs,
      hardPromptMs,
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

function buildCandidateForActiveSession(
  sql: SqlStorage,
  env: DOEnv,
  opts: {
    sessionId: string;
    workspaceId: string;
    taskId: string;
    lastActivityAt: number;
    action: 'checkin' | 'recovery_checkin';
    recoveryErrorMessage: string | null;
    softPromptMs?: number;
    hardPromptMs?: number;
  }
): ReconciliationCandidate | null {
  const now = Date.now();
  const softPromptMs = opts.softPromptMs ?? promptSoftStallMs(env);
  const hardPromptMs = opts.hardPromptMs ?? promptHardStallMs(env);

  const acpRows = sql
    .exec(
      `SELECT id FROM acp_sessions
     WHERE workspace_id = ? AND status IN ('running', 'started')
     ORDER BY created_at DESC LIMIT 1`,
      opts.workspaceId
    )
    .toArray();

  const acpRow = acpRows[0];
  if (!acpRow?.id) {
    log.warn('reconciliation.no_active_acp_session', {
      sessionId: opts.sessionId,
      workspaceId: opts.workspaceId,
    });
    return null;
  }

  const acpSessionId = acpRow.id as string;
  const stateRow = sql
    .exec(
      `SELECT activity, activity_at, prompt_started_at FROM session_state WHERE session_id = ?`,
      acpSessionId
    )
    .toArray()[0] as SessionStateRow | undefined;

  let action: ReconciliationCandidate['action'] = opts.action;
  let promptStartedAt: number | null = null;
  let promptAgeMs: number | null = null;

  if (stateRow?.activity === 'prompting') {
    if (opts.action === 'recovery_checkin') {
      log.info('reconciliation.recovery_prompt_deferred_prompt_in_flight', {
        sessionId: opts.sessionId,
        taskId: opts.taskId,
        workspaceId: opts.workspaceId,
        acpSessionId,
      });
      return null;
    }

    promptStartedAt = stateRow.prompt_started_at || stateRow.activity_at || opts.lastActivityAt;
    promptAgeMs = Math.max(0, now - promptStartedAt);

    if (promptAgeMs < softPromptMs) {
      log.info('reconciliation.prompt_in_flight_deferred', {
        sessionId: opts.sessionId,
        taskId: opts.taskId,
        workspaceId: opts.workspaceId,
        acpSessionId,
        promptAgeMs,
        softPromptMs,
      });
      return null;
    }

    action = promptAgeMs >= hardPromptMs ? 'cancel_prompt' : 'observe_prompt';
  }

  return {
    sessionId: opts.sessionId,
    workspaceId: opts.workspaceId,
    taskId: opts.taskId,
    acpSessionId,
    lastActivityAt: opts.lastActivityAt,
    idleDurationMs: now - opts.lastActivityAt,
    action,
    promptStartedAt,
    promptAgeMs,
    recoveryErrorMessage: opts.recoveryErrorMessage,
  };
}

function getLatestRecoverableErrorEvent(
  sql: SqlStorage,
  sessionId: string,
  taskId: string,
  fallbackErrorMessage: string | null
): RecoverableErrorEvent | null {
  const row = sql
    .exec(
      `SELECT created_at, payload FROM activity_events
     WHERE event_type = 'task.agent_error_recoverable'
       AND task_id = ?
       AND (session_id = ? OR session_id IS NULL)
     ORDER BY created_at DESC
     LIMIT 1`,
      taskId,
      sessionId
    )
    .toArray()[0];

  if (!row) return null;

  return {
    createdAt: (row.created_at as number) || 0,
    errorMessage: sanitizeRecoveryErrorMessage(
      extractErrorMessageFromPayload(row.payload as string | null) ?? fallbackErrorMessage
    ),
  };
}

function extractErrorMessageFromPayload(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { errorMessage?: unknown };
    return typeof parsed.errorMessage === 'string' ? parsed.errorMessage : null;
  } catch {
    return null;
  }
}

function sanitizeRecoveryErrorMessage(message: string | null): string | null {
  const redacted = redactRecoveryDiagnosticText(message ?? '');
  const withoutControlChars = Array.from(redacted, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : char;
  }).join('');
  const normalized = withoutControlChars.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= RECOVERY_ERROR_DETAIL_MAX_CHARS) return normalized;
  return `${normalized.slice(0, RECOVERY_ERROR_DETAIL_MAX_CHARS).trimEnd()}...`;
}

function redactRecoveryDiagnosticText(text: string): string {
  return text
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, `$1${REDACTED_DIAGNOSTIC_VALUE}`)
    .replace(
      /\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi,
      `$1${REDACTED_DIAGNOSTIC_VALUE}`
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, REDACTED_DIAGNOSTIC_VALUE)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, REDACTED_DIAGNOSTIC_VALUE)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, REDACTED_DIAGNOSTIC_VALUE)
    .replace(/\bsam_test_[A-Za-z0-9_-]{12,}\b/g, REDACTED_DIAGNOSTIC_VALUE);
}

function buildRecoveryCheckinPrompt(errorMessage: string | null): string {
  const diagnostic = errorMessage ? ` Diagnostic: ${errorMessage}` : '';
  return (
    '[SAM Orchestrator Recovery] SAM detected that the previous prompt hit a recoverable agent/session error, ' +
    'and this conversation has been idle since then.' +
    diagnostic +
    ' Please briefly acknowledge the recovery, avoid repeating the exact failing operation if possible, ' +
    'and continue from where you left off. If you need human input to proceed, ask for it clearly.'
  );
}

/**
 * Process reconciliation candidates — send check-in messages and create
 * response deadline markers.
 */
export async function processReconciliationCandidates(
  sql: SqlStorage,
  env: DOEnv,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
  hooks: ReconciliationProcessingHooks = {}
): Promise<number> {
  const candidates = (await getReconciliationCandidates(sql, env)).slice(
    0,
    maxCandidatesPerSweep(env)
  );
  if (candidates.length === 0) return 0;

  const deadlineMs = reconciliationDeadlineMs(env);

  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      try {
        const targetResult = await resolveWorkspaceDeliveryTarget(
          env as unknown as WorkerEnv,
          candidate.workspaceId,
          hooks.projectId ?? null
        );
        if (!targetResult.ok) {
          await terminallyFailDeadTarget(sql, env, candidate, targetResult, hooks);
          return 1;
        }

        if (candidate.action === 'observe_prompt') {
          return recordPromptInFlightObservation(sql, candidate) ? 1 : 0;
        }

        if (candidate.action === 'cancel_prompt') {
          await cancelStalledPrompt(sql, env, candidate, targetResult.target, broadcastEvent);
          return 1;
        }

        const isRecoveryCheckin = candidate.action === 'recovery_checkin';
        const prompt = isRecoveryCheckin
          ? buildRecoveryCheckinPrompt(candidate.recoveryErrorMessage)
          : CHECKIN_PROMPT;
        const metadata = isRecoveryCheckin ? RECOVERY_CHECKIN_METADATA : CHECKIN_METADATA;
        const markerExpiresAt = isRecoveryCheckin ? null : Date.now() + deadlineMs;

        // 1. Persist the check-in as a user-role message with SAM metadata
        const msgResult = persistMessage(sql, env, candidate.sessionId, 'user', prompt, metadata);

        // 2. Create a reconciliation_checkin attention marker. Task-mode markers
        // expire into a visible failure; conversation recovery markers stay open
        // until the agent or user responds.
        const marker = createAttentionMarker(sql, {
          sessionId: candidate.sessionId,
          taskId: candidate.taskId,
          workspaceId: candidate.workspaceId,
          kind: 'reconciliation_checkin',
          source: 'sam_orchestrator',
          sourceMessageId: msgResult.id,
          reason: isRecoveryCheckin
            ? `Agent recovered from an error and stayed idle for ${Math.round(candidate.idleDurationMs / 1000)}s — SAM recovery check-in sent`
            : `Agent idle for ${Math.round(candidate.idleDurationMs / 1000)}s — SAM check-in sent`,
          metadata: isRecoveryCheckin
            ? JSON.stringify({
                recovery: 'conversation_error',
                errorMessage: candidate.recoveryErrorMessage,
              })
            : null,
          expiresAt: markerExpiresAt,
        });

        // 3. Send the prompt to the VM agent off the alarm critical path. The
        //    marker above is the correctness boundary: task-mode send failure
        //    lets the marker expire, while conversation recovery stays visible.
        waitUntil(
          hooks,
          sendCheckinToAgent(env, candidate, targetResult.target, prompt).catch((err) => {
            log.warn('reconciliation.send_prompt_failed', {
              sessionId: candidate.sessionId,
              workspaceId: candidate.workspaceId,
              error: err instanceof Error ? err.message : String(err),
            });
          })
        );

        // 4. Record activity event
        recordActivityEventInternal(
          sql,
          isRecoveryCheckin
            ? 'reconciliation.recovery_checkin_sent'
            : 'reconciliation.checkin_sent',
          'system',
          null,
          candidate.workspaceId,
          candidate.sessionId,
          candidate.taskId,
          JSON.stringify({
            messageId: msgResult.id,
            markerId: marker.id,
            idleDurationMs: candidate.idleDurationMs,
            deadlineMs: markerExpiresAt === null ? null : deadlineMs,
            recoveryErrorMessage: isRecoveryCheckin ? candidate.recoveryErrorMessage : undefined,
          })
        );

        broadcastEvent(
          'message.new',
          {
            sessionId: candidate.sessionId,
            messageId: msgResult.id,
            role: 'user',
            content: prompt,
            toolMetadata: JSON.parse(metadata),
            createdAt: msgResult.now,
            sequence: msgResult.sequence,
          },
          candidate.sessionId
        );

        broadcastEvent(
          'attention.created',
          {
            sessionId: candidate.sessionId,
            markerId: marker.id,
            kind: 'reconciliation_checkin',
          },
          candidate.sessionId
        );

        log.info(
          isRecoveryCheckin
            ? 'reconciliation.recovery_checkin_sent'
            : 'reconciliation.checkin_sent',
          {
            sessionId: candidate.sessionId,
            taskId: candidate.taskId,
            workspaceId: candidate.workspaceId,
            markerId: marker.id,
            messageId: msgResult.id,
            idleDurationMs: candidate.idleDurationMs,
          }
        );

        return 1;
      } catch (err) {
        log.error('reconciliation.checkin_failed', {
          sessionId: candidate.sessionId,
          taskId: candidate.taskId,
          ...serializeError(err),
        });
        return 0;
      }
    })
  );

  return results.reduce(
    (count, result) => count + (result.status === 'fulfilled' ? result.value : 0),
    0
  );
}

function recordPromptInFlightObservation(
  sql: SqlStorage,
  candidate: ReconciliationCandidate
): boolean {
  const observedSince = candidate.promptStartedAt ?? candidate.lastActivityAt;
  const alreadyObserved = sql
    .exec(
      `SELECT 1 FROM activity_events
     WHERE event_type = 'reconciliation.prompt_in_flight_observed'
       AND session_id = ?
       AND task_id = ?
       AND created_at >= ?
     LIMIT 1`,
      candidate.sessionId,
      candidate.taskId,
      observedSince
    )
    .toArray();
  if (alreadyObserved.length > 0) return false;

  recordActivityEventInternal(
    sql,
    'reconciliation.prompt_in_flight_observed',
    'system',
    null,
    candidate.workspaceId,
    candidate.sessionId,
    candidate.taskId,
    JSON.stringify({
      acpSessionId: candidate.acpSessionId,
      promptStartedAt: candidate.promptStartedAt,
      promptAgeMs: candidate.promptAgeMs,
      idleDurationMs: candidate.idleDurationMs,
    })
  );

  log.info('reconciliation.prompt_in_flight_observed', {
    sessionId: candidate.sessionId,
    taskId: candidate.taskId,
    workspaceId: candidate.workspaceId,
    acpSessionId: candidate.acpSessionId,
    promptAgeMs: candidate.promptAgeMs,
  });

  return true;
}

async function cancelStalledPrompt(
  sql: SqlStorage,
  env: DOEnv,
  candidate: ReconciliationCandidate,
  target: WorkspaceDeliveryTarget,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void
): Promise<void> {
  const workerEnv = env as unknown as WorkerEnv;

  const result = await cancelAgentSessionOnNode(
    target.nodeId,
    candidate.workspaceId,
    candidate.acpSessionId,
    workerEnv,
    target.userId,
    { requestTimeoutMs: reconciliationNodeCallTimeoutMs(env) }
  );

  if (!result.success && result.status === 409) {
    // The VM no longer has a prompt in flight; repair the stale mirror so the
    // next reconciliation pass can send the visible check-in normally.
    upsertActivityState(sql, candidate.acpSessionId, { activity: 'idle' });
    broadcastEvent(
      'session.activity',
      {
        sessionId: candidate.sessionId,
        activity: 'idle',
        promptStartedAt: null,
      },
      candidate.sessionId
    );
  }

  recordActivityEventInternal(
    sql,
    'reconciliation.prompt_cancel_requested',
    'system',
    null,
    candidate.workspaceId,
    candidate.sessionId,
    candidate.taskId,
    JSON.stringify({
      acpSessionId: candidate.acpSessionId,
      promptStartedAt: candidate.promptStartedAt,
      promptAgeMs: candidate.promptAgeMs,
      idleDurationMs: candidate.idleDurationMs,
      success: result.success,
      status: result.status,
    })
  );

  log.warn('reconciliation.prompt_cancel_requested', {
    sessionId: candidate.sessionId,
    taskId: candidate.taskId,
    workspaceId: candidate.workspaceId,
    acpSessionId: candidate.acpSessionId,
    promptAgeMs: candidate.promptAgeMs,
    success: result.success,
    status: result.status,
  });
}

/**
 * Send the check-in prompt to the VM agent via the node agent service.
 * This requires the full Worker env for JWT signing and node routing.
 */
async function sendCheckinToAgent(
  env: DOEnv,
  candidate: ReconciliationCandidate,
  target: WorkspaceDeliveryTarget,
  prompt: string
): Promise<void> {
  const workerEnv = env as unknown as WorkerEnv;

  await sendPromptToAgentOnNode(
    target.nodeId,
    candidate.workspaceId,
    candidate.acpSessionId,
    prompt,
    workerEnv,
    target.userId,
    undefined,
    { requestTimeoutMs: reconciliationNodeCallTimeoutMs(env) }
  );
}

async function resolveWorkspaceDeliveryTarget(
  env: WorkerEnv,
  workspaceId: string,
  projectId: string | null
): Promise<WorkspaceDeliveryTargetResult> {
  const staleMs = nodeHeartbeatStaleMs(env as unknown as DOEnv);
  const wsRow = await env.DATABASE.prepare(
    `SELECT
       w.node_id,
       w.user_id,
       w.project_id,
       n.status AS node_status,
       n.health_status,
       n.last_heartbeat_at
     FROM workspaces w
     LEFT JOIN nodes n ON n.id = w.node_id
     WHERE w.id = ?
     LIMIT 1`
  )
    .bind(workspaceId)
    .first<{
      node_id: string | null;
      user_id: string;
      project_id: string | null;
      node_status: string | null;
      health_status: string | null;
      last_heartbeat_at: string | null;
    }>();

  if (!wsRow) {
    log.warn('reconciliation.workspace_missing', { workspaceId });
    return { ok: false, reason: 'workspace_missing', nodeId: null, userId: null, projectId: null };
  }

  if (projectId && wsRow.project_id && wsRow.project_id !== projectId) {
    log.error('reconciliation.workspace_project_mismatch', {
      workspaceId,
      expectedProjectId: projectId,
      actualProjectId: wsRow.project_id,
      action: 'rejected',
    });
    return {
      ok: false,
      reason: 'workspace_project_mismatch',
      nodeId: wsRow.node_id,
      userId: wsRow.user_id,
      projectId: wsRow.project_id,
    };
  }

  if (!wsRow?.node_id) {
    log.warn('reconciliation.workspace_missing_node', { workspaceId });
    return {
      ok: false,
      reason: 'workspace_missing_node',
      nodeId: null,
      userId: wsRow.user_id,
      projectId: wsRow.project_id,
    };
  }

  if (wsRow.node_status !== 'running') {
    log.warn('reconciliation.node_not_running', {
      workspaceId,
      nodeId: wsRow.node_id,
      nodeStatus: wsRow.node_status,
    });
    return {
      ok: false,
      reason: wsRow.node_status ? 'node_not_running' : 'node_missing',
      nodeId: wsRow.node_id,
      userId: wsRow.user_id,
      projectId: wsRow.project_id,
    };
  }

  if (wsRow.health_status !== 'healthy') {
    log.warn('reconciliation.node_unhealthy', {
      workspaceId,
      nodeId: wsRow.node_id,
      healthStatus: wsRow.health_status,
    });
    return {
      ok: false,
      reason: 'node_unhealthy',
      nodeId: wsRow.node_id,
      userId: wsRow.user_id,
      projectId: wsRow.project_id,
    };
  }

  if (!wsRow.last_heartbeat_at) {
    log.warn('reconciliation.node_missing_heartbeat', { workspaceId, nodeId: wsRow.node_id });
    return {
      ok: false,
      reason: 'node_missing_heartbeat',
      nodeId: wsRow.node_id,
      userId: wsRow.user_id,
      projectId: wsRow.project_id,
    };
  }

  const heartbeatAt = new Date(wsRow.last_heartbeat_at).getTime();
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > staleMs) {
    log.warn('reconciliation.node_stale_heartbeat', {
      workspaceId,
      nodeId: wsRow.node_id,
      lastHeartbeatAt: wsRow.last_heartbeat_at,
      staleMs,
    });
    return {
      ok: false,
      reason: 'node_stale_heartbeat',
      nodeId: wsRow.node_id,
      userId: wsRow.user_id,
      projectId: wsRow.project_id,
    };
  }

  return { ok: true, target: { nodeId: wsRow.node_id, userId: wsRow.user_id } };
}

function waitUntil(hooks: ReconciliationProcessingHooks, promise: Promise<unknown>): void {
  if (hooks.waitUntil) {
    hooks.waitUntil(promise);
    return;
  }
  void promise;
}

/**
 * Compute the next alarm time for reconciliation checks.
 *
 * Looks at active task-linked sessions and returns when the next reconciliation
 * check should fire. Task mode is verified when processing candidates; this
 * alarm calculation intentionally stays DO-local.
 */
export function computeReconciliationAlarmTime(sql: SqlStorage, env: DOEnv): number | null {
  const idleThresholdMs = reconciliationIdleMs(env);
  const softPromptMs = promptSoftStallMs(env);
  const hardPromptMs = promptHardStallMs(env);
  const minAlarmDelayMs = minReconciliationAlarmDelayMs(env);

  // Find the earliest activity among active task-linked sessions that don't
  // have an active reconciliation or needs_input marker. Join active ACP
  // sessions so old active chat rows without a running agent do not keep the
  // ProjectData alarm hot forever.
  const rows = sql
    .exec(
      `SELECT
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
       ) AS last_activity,
       ss.activity AS session_activity,
       ss.activity_at AS session_activity_at,
       ss.prompt_started_at AS prompt_started_at
     FROM chat_sessions cs
     LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
     LEFT JOIN workspace_activity wa ON wa.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
     JOIN acp_sessions acp ON acp.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
       AND acp.status IN ('running', 'started')
     LEFT JOIN session_state ss ON ss.session_id = acp.id
     WHERE cs.status = 'active'
       AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
       AND COALESCE(ics.workspace_id, cs.workspace_id) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM session_attention_markers sam
         WHERE sam.session_id = cs.id
           AND sam.resolved_at IS NULL
           AND sam.kind IN ('needs_input', 'reconciliation_checkin')
       )`
    )
    .toArray();

  if (rows.length === 0) {
    return null;
  }

  let nextCheck: number | null = null;
  const now = Date.now();

  for (const row of rows) {
    const lastActivity = row.last_activity as number | null | undefined;
    if (lastActivity === null || lastActivity === undefined) continue;

    let candidateTime = lastActivity + idleThresholdMs;
    if (row.session_activity === 'prompting') {
      const promptStartedAt =
        (row.prompt_started_at as number | null | undefined) ||
        (row.session_activity_at as number | null | undefined) ||
        lastActivity;
      const promptAgeMs = Math.max(0, now - promptStartedAt);
      const promptThreshold = promptAgeMs < softPromptMs ? softPromptMs : hardPromptMs;
      candidateTime = Math.max(candidateTime, promptStartedAt + promptThreshold);
    }

    nextCheck = nextCheck === null ? candidateTime : Math.min(nextCheck, candidateTime);
  }

  if (nextCheck === null) return null;

  // Ensure we don't schedule in the past.
  return Math.max(nextCheck, now + minAlarmDelayMs);
}
