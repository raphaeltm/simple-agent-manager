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
import * as v from 'valibot';

import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger, serializeError } from '../../lib/logger';
import { cancelAgentSessionOnNode, sendPromptToAgentOnNode } from '../../services/node-agent';
import { classifyTaskRuntimeDelivery } from '../../services/task-runtime-liveness';
import { parseRowOrNull } from '../row-validation';
import { recordActivityEventInternal } from './activity';
import { createAttentionMarker } from './attention';
import { persistMessage } from './messages';
import {
  type ReconciliationProcessingHooks,
  terminallyFailDeadTarget,
} from './reconciliation-dead-target';
import {
  maxCandidatesPerSweep,
  minReconciliationAlarmDelayMs,
  promptHardStallMs,
  promptSoftStallMs,
  reconciliationDeadlineMs,
  reconciliationIdleMs,
  reconciliationNodeCallTimeoutMs,
} from './reconciliation-thresholds';
import { upsertActivityState } from './session-state';
import { getLocalTaskRuntimeLiveness } from './task-runtime-liveness';
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

/** `SELECT activity, activity_at, prompt_started_at FROM session_state ...` shape. */
const SessionStateRowSchema = v.object({
  activity: v.nullable(v.string()),
  activity_at: v.nullable(v.number()),
  prompt_started_at: v.nullable(v.number()),
});

interface WorkspaceDeliveryTarget {
  nodeId: string;
  userId: string;
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
  env: DOEnv
): Promise<ReconciliationCandidate[]> {
  const now = Date.now();
  const idleThresholdMs = reconciliationIdleMs(env);
  const idleThreshold = now - idleThresholdMs;
  const softPromptMs = promptSoftStallMs(env);
  const hardPromptMs = promptHardStallMs(env);
  const candidateLimit = maxCandidatesPerSweep(env);

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
       )
     ORDER BY last_activity_at ASC
     LIMIT ?`,
      candidateLimit
    )
    .toArray();

  const candidates: ReconciliationCandidate[] = [];

  for (const row of rows) {
    const sessionId = row.session_id as string;
    const workspaceId = row.workspace_id as string;
    const taskId = row.task_id as string;
    const lastActivityAt = (row.last_activity_at as number) || 0;
    let projectId: string | null = null;

    // Check if the session has been idle long enough
    if (lastActivityAt > idleThreshold) continue;

    // Verify task is still active and task_mode = 'task' via D1
    try {
      const taskRow = await env.DATABASE.prepare(
        `SELECT task_mode, status, project_id FROM tasks WHERE id = ? LIMIT 1`
      )
        .bind(taskId)
        .first<{ task_mode: string | null; status: string; project_id: string | null }>();

      if (!taskRow) continue;
      if (taskRow.task_mode !== 'task') continue;
      if (!['in_progress', 'delegated', 'awaiting_followup'].includes(taskRow.status)) continue;
      if (!taskRow.project_id) continue;
      projectId = taskRow.project_id;
    } catch (err) {
      log.warn('reconciliation.d1_task_query_failed', { taskId, ...serializeError(err) });
      continue;
    }
    if (!projectId) continue;

    // Find active ACP session for this workspace (DO SQLite)
    const acpRows = sql
      .exec(
        `SELECT id FROM acp_sessions
       WHERE workspace_id = ? AND status IN ('running', 'started')
       ORDER BY created_at DESC LIMIT 1`,
        workspaceId
      )
      .toArray();

    const acpRow = acpRows[0];
    if (!acpRow?.id) {
      log.warn('reconciliation.no_active_acp_session', { sessionId, workspaceId });
      continue;
    }

    const acpSessionId = acpRow.id as string;
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
        log.info('reconciliation.prompt_in_flight_deferred', {
          sessionId,
          taskId,
          workspaceId,
          acpSessionId,
          promptAgeMs,
          softPromptMs,
        });
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
  const candidates = await getReconciliationCandidates(sql, env);
  if (candidates.length === 0) return 0;

  const deadlineMs = reconciliationDeadlineMs(env);
  let localObservations = 0;

  // `observe_prompt` is a fact already present in this Durable Object. Record
  // every such fact before starting any workspace/node resolution so a stale
  // cross-boundary mirror cannot suppress it. The background assessment below
  // still lets explicit terminal ownership evidence converge afterward.
  for (const candidate of candidates) {
    if (candidate.action === 'observe_prompt' && recordPromptInFlightObservation(sql, candidate)) {
      localObservations += 1;
    }
  }

  const remoteWork = Promise.allSettled(
    candidates.map(async (candidate) => {
      try {
        const projectId = hooks.projectId ?? candidate.projectId;
        if (hooks.projectId && hooks.projectId !== candidate.projectId) {
          log.error('reconciliation.project_identity_mismatch', {
            sessionId: candidate.sessionId,
            taskId: candidate.taskId,
            workspaceId: candidate.workspaceId,
            taskProjectId: candidate.projectId,
            durableObjectProjectId: hooks.projectId,
            action: 'preserved',
          });
          return 0;
        }

        const liveness = await getLocalTaskRuntimeLiveness(sql, env, {
          taskId: candidate.taskId,
          projectId,
          workspaceId: candidate.workspaceId,
        });
        const delivery = classifyTaskRuntimeDelivery(liveness);
        if (delivery.kind === 'terminal') {
          await terminallyFailDeadTarget(
            sql,
            env,
            candidate,
            { reason: delivery.reason, nodeId: delivery.nodeId, projectId },
            hooks
          );
          return 1;
        }

        if (candidate.action === 'observe_prompt') {
          if (delivery.kind === 'inconclusive') {
            log.warn('reconciliation.prompt_observation_liveness_inconclusive', {
              sessionId: candidate.sessionId,
              taskId: candidate.taskId,
              workspaceId: candidate.workspaceId,
              reason: delivery.reason,
              action: 'preserved',
            });
          }
          return 0;
        }

        if (delivery.kind === 'inconclusive') {
          log.warn('reconciliation.delivery_deferred', {
            sessionId: candidate.sessionId,
            taskId: candidate.taskId,
            workspaceId: candidate.workspaceId,
            reason: delivery.reason,
            action: 'preserved',
          });
          return 0;
        }

        if (candidate.action === 'cancel_prompt') {
          await cancelStalledPrompt(sql, env, candidate, delivery.target, broadcastEvent);
          return 1;
        }

        // Runtime acceptance is the correctness boundary. A timeout/error here
        // remains inconclusive and creates no failure-capable deadline.
        await sendCheckinToAgent(env, candidate, delivery.target);

        // Persist/broadcast only after accepted delivery, so transcript state
        // cannot claim SAM sent a prompt the runtime never received.
        const msgResult = persistMessage(
          sql,
          env,
          candidate.sessionId,
          'user',
          CHECKIN_PROMPT,
          CHECKIN_METADATA
        );

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
          })
        );

        broadcastEvent(
          'message.new',
          {
            sessionId: candidate.sessionId,
            messageId: msgResult.id,
            role: 'user',
            content: CHECKIN_PROMPT,
            toolMetadata: JSON.parse(CHECKIN_METADATA),
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

        log.info('reconciliation.checkin_sent', {
          sessionId: candidate.sessionId,
          taskId: candidate.taskId,
          workspaceId: candidate.workspaceId,
          markerId: marker.id,
          messageId: msgResult.id,
          idleDurationMs: candidate.idleDurationMs,
        });

        return 1;
      } catch (err) {
        log.warn('reconciliation.candidate_processing_inconclusive', {
          sessionId: candidate.sessionId,
          taskId: candidate.taskId,
          workspaceId: candidate.workspaceId,
          action: 'preserved',
          ...serializeError(err),
        });
        return 0;
      }
    })
  );

  if (hooks.waitUntil) {
    hooks.waitUntil(remoteWork);
    return localObservations;
  }

  const results = await remoteWork;
  return (
    localObservations +
    results.reduce((count, result) => count + (result.status === 'fulfilled' ? result.value : 0), 0)
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
    //
    // NOT ON the shared terminal-write path (`session-state.recordTurnEnd` +
    // `session-activity-reconciliation.publishTurnEnd`), so this repair records
    // no activity provenance and skips the delivery nudge / idle re-arm that
    // `.claude/rules/57` requires of a terminal transition. Pre-existing
    // behaviour; migrating it changes task-mode reconciliation semantics and is
    // tracked in
    // `tasks/backlog/2026-08-17-migrate-cancel-stalled-prompt-to-record-turn-end.md`
    // (`.claude/rules/42`).
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
  target: WorkspaceDeliveryTarget
): Promise<void> {
  const workerEnv = env as unknown as WorkerEnv;

  await sendPromptToAgentOnNode(
    target.nodeId,
    candidate.workspaceId,
    candidate.acpSessionId,
    CHECKIN_PROMPT,
    workerEnv,
    target.userId,
    undefined,
    { requestTimeoutMs: reconciliationNodeCallTimeoutMs(env) }
  );
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
