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
import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger, serializeError } from '../../lib/logger';
import { cancelAgentSessionOnNode } from '../../services/node-agent';
import { classifyTaskRuntimeDelivery } from '../../services/task-runtime-liveness';
import { DefaultVmPromptDeliveryAdapter } from '../../services/vm-prompt-delivery-adapter';
import { recordActivityEventInternal } from './activity';
import { createAttentionMarker } from './attention';
import { persistMessage } from './messages';
import type { PromptDeliveryClaim } from './prompt-delivery';
import {
  CANDIDATE_GATE_META_PREFIX,
  clearReconciliationCandidateGate,
  deferReconciliationCandidateUntil,
  getOrCreateReconciliationCheckinIntent,
  parseReconciliationCandidateGate,
  type ReconciliationCheckinIntent,
  recordReconciliationCandidateInconclusive,
} from './reconciliation-candidate-state';
import {
  getReconciliationCandidates,
  type ReconciliationCandidate,
} from './reconciliation-candidates';
import {
  type ReconciliationProcessingHooks,
  terminallyFailDeadTarget,
} from './reconciliation-dead-target';
import {
  minReconciliationAlarmDelayMs,
  promptHardStallMs,
  promptSoftStallMs,
  reconciliationCandidateLeaseMs,
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

function checkinMetadata(deliveryId: string): Record<string, unknown> {
  return {
    source: 'sam_orchestrator',
    kind: 'reconciliation_checkin',
    deliveryId,
  };
}

export type { ReconciliationCandidate } from './reconciliation-candidates';
export { getReconciliationCandidates } from './reconciliation-candidates';

interface WorkspaceDeliveryTarget {
  nodeId: string;
  userId: string;
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
  const promptDeliveryAdapter = new DefaultVmPromptDeliveryAdapter(env as unknown as WorkerEnv);
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
        const hasHookProjectId = Object.prototype.hasOwnProperty.call(hooks, 'projectId');
        const projectId = hasHookProjectId ? hooks.projectId : candidate.projectId;
        if (!projectId || projectId !== candidate.projectId) {
          log.error('reconciliation.project_identity_mismatch', {
            sessionId: candidate.sessionId,
            taskId: candidate.taskId,
            workspaceId: candidate.workspaceId,
            taskProjectId: candidate.projectId,
            durableObjectProjectId: projectId ?? null,
            action: 'preserved',
          });
          recordReconciliationCandidateInconclusive(sql, env, {
            ...candidate,
            reason: 'project_identity_mismatch',
          });
          return 0;
        }

        const liveness = await getLocalTaskRuntimeLiveness(sql, env, {
          taskId: candidate.taskId,
          projectId,
          workspaceId: candidate.workspaceId,
          chatSessionId: candidate.sessionId,
          acpSessionId: candidate.acpSessionId,
        });
        const delivery = classifyTaskRuntimeDelivery(liveness);
        if (delivery.kind === 'terminal') {
          const transitioned = await terminallyFailDeadTarget(
            sql,
            env,
            candidate,
            { reason: delivery.reason, nodeId: delivery.nodeId, projectId },
            hooks
          );
          if (transitioned) {
            clearReconciliationCandidateGate(sql, candidate.sessionId);
            return 1;
          }
          recordReconciliationCandidateInconclusive(sql, env, {
            ...candidate,
            reason: 'terminal_ownership_transition_skipped',
          });
          return 0;
        }

        if (candidate.action === 'observe_prompt') {
          if (!liveness.live || !liveness.conclusive) {
            log.warn('reconciliation.prompt_observation_liveness_inconclusive', {
              sessionId: candidate.sessionId,
              taskId: candidate.taskId,
              workspaceId: candidate.workspaceId,
              reason: liveness.reason,
              action: 'preserved',
            });
            recordReconciliationCandidateInconclusive(sql, env, {
              ...candidate,
              reason: delivery.kind === 'inconclusive' ? delivery.reason : liveness.reason,
            });
          } else {
            deferReconciliationCandidateUntil(
              sql,
              candidate.sessionId,
              Math.max(
                Date.now() + reconciliationCandidateLeaseMs(env),
                (candidate.promptStartedAt ?? Date.now()) + promptHardStallMs(env)
              )
            );
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
          recordReconciliationCandidateInconclusive(sql, env, {
            ...candidate,
            reason: delivery.reason,
          });
          return 0;
        }

        if (candidate.action === 'cancel_prompt') {
          const accepted = await cancelStalledPrompt(
            sql,
            env,
            candidate,
            delivery.target,
            broadcastEvent
          );
          if (!accepted) {
            recordReconciliationCandidateInconclusive(sql, env, {
              ...candidate,
              reason: 'prompt_cancel_not_accepted',
            });
            return 0;
          }
          deferReconciliationCandidateUntil(
            sql,
            candidate.sessionId,
            Date.now() + reconciliationCandidateLeaseMs(env)
          );
          return 1;
        }

        // Persist stable receipt/transcript identity BEFORE crossing the VM
        // boundary. A lost response or a later local write failure can then
        // safely replay the same intent; the VM returns the existing receipt
        // instead of executing a duplicate prompt.
        const intent = getOrCreateReconciliationCheckinIntent(
          sql,
          candidate.sessionId,
          candidate.taskId
        );
        const deliveryResult = await sendCheckinToAgent(
          env,
          candidate,
          delivery.target,
          intent,
          promptDeliveryAdapter
        );
        if (deliveryResult.kind !== 'accepted') {
          throw new Error(
            `reconciliation_checkin_${deliveryResult.kind}:${'reason' in deliveryResult ? deliveryResult.reason : 'unknown'}`
          );
        }

        // Persist/broadcast only after accepted delivery, so transcript state
        // cannot claim SAM sent a prompt the runtime never received.
        const metadata = checkinMetadata(intent.deliveryId);
        const msgResult = persistMessage(
          sql,
          env,
          candidate.sessionId,
          'user',
          CHECKIN_PROMPT,
          JSON.stringify(metadata),
          intent.promptMessageId
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
            deliveryId: intent.deliveryId,
            idleDurationMs: candidate.idleDurationMs,
            deadlineMs,
            acceptedAt: deliveryResult.promptEpoch,
          })
        );

        broadcastEvent(
          'message.new',
          {
            sessionId: candidate.sessionId,
            messageId: msgResult.id,
            role: 'user',
            content: CHECKIN_PROMPT,
            toolMetadata: metadata,
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
          deliveryId: intent.deliveryId,
          idleDurationMs: candidate.idleDurationMs,
        });

        clearReconciliationCandidateGate(sql, candidate.sessionId);
        return 1;
      } catch (err) {
        log.warn('reconciliation.candidate_processing_inconclusive', {
          sessionId: candidate.sessionId,
          taskId: candidate.taskId,
          workspaceId: candidate.workspaceId,
          action: 'preserved',
          ...serializeError(err),
        });
        recordReconciliationCandidateInconclusive(sql, env, {
          ...candidate,
          reason: err instanceof Error ? err.message : String(err),
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
): Promise<boolean> {
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
  return result.success || result.status === 409;
}

/**
 * Send the check-in prompt to the VM agent via the node agent service.
 * This requires the full Worker env for JWT signing and node routing.
 */
async function sendCheckinToAgent(
  env: DOEnv,
  candidate: ReconciliationCandidate,
  target: WorkspaceDeliveryTarget,
  intent: ReconciliationCheckinIntent,
  adapter: DefaultVmPromptDeliveryAdapter
) {
  const claim: PromptDeliveryClaim = {
    attemptId: intent.deliveryId,
    mode: 'submit',
    message: {
      id: intent.deliveryId,
      targetSessionId: candidate.sessionId,
      sourceTaskId: candidate.taskId,
      senderType: 'system',
      senderId: null,
      messageClass: 'deliver',
      deliveryState: 'delivering',
      content: CHECKIN_PROMPT,
      metadata: checkinMetadata(intent.deliveryId),
      ackRequired: false,
      ackTimeoutMs: null,
      deliveryAttempts: 1,
      lastDeliveryAt: intent.createdAt,
      expiresAt: null,
      createdAt: intent.createdAt,
      deliveredAt: null,
      ackedAt: null,
      sourceKind: 'agent_mailbox',
      promptMessageId: intent.promptMessageId,
      nextAttemptAt: intent.createdAt,
      lastError: null,
      terminalReason: null,
      attemptId: intent.deliveryId,
      attemptStartedAt: intent.createdAt,
      runtimeIdentity: null,
      receiptState: null,
      receiptRuntimeIdentity: null,
      receiptCheckedAt: null,
      acceptedAt: null,
      adapterProtocolVersion: null,
      receiptSupported: null,
    },
  };

  return adapter.submit({
    projectId: candidate.projectId,
    claim,
    allowLegacyVm: false,
    requestTimeoutMs: reconciliationNodeCallTimeoutMs(env),
    resolvedTarget: {
      projectId: candidate.projectId,
      chatSessionId: candidate.sessionId,
      workspaceId: candidate.workspaceId,
      nodeId: target.nodeId,
      agentSessionId: candidate.acpSessionId,
      userId: target.userId,
      // Versioned capability negotiation supplies the authoritative runtime
      // identity. This local value is used only to fail closed for legacy VMs.
      runtimeIdentity: `${target.nodeId}:${candidate.acpSessionId}`,
      runtime: 'vm',
    },
    sourceTaskGuard: {
      taskId: candidate.taskId,
      projectId: candidate.projectId,
      chatSessionId: candidate.sessionId,
    },
  });
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
       cs.id AS session_id,
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
       ) AS last_activity,
       ss.activity AS session_activity,
       ss.activity_at AS session_activity_at,
       ss.prompt_started_at AS prompt_started_at,
       gate.value AS reconciliation_gate
     FROM chat_sessions cs
     LEFT JOIN idle_cleanup_schedule ics ON ics.session_id = cs.id
     LEFT JOIN workspace_activity wa ON wa.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
     JOIN acp_sessions acp ON acp.workspace_id = COALESCE(ics.workspace_id, cs.workspace_id)
       AND acp.chat_session_id = cs.id
       AND acp.status IN ('assigned', 'running')
     LEFT JOIN session_state ss ON ss.session_id = acp.id
     LEFT JOIN do_meta gate ON gate.key = ? || cs.id
     WHERE cs.status = 'active'
       AND COALESCE(ics.task_id, cs.task_id) IS NOT NULL
       AND COALESCE(ics.workspace_id, cs.workspace_id) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM session_attention_markers sam
         WHERE sam.session_id = cs.id
           AND sam.resolved_at IS NULL
           AND sam.kind IN ('needs_input', 'reconciliation_checkin')
       )`,
      CANDIDATE_GATE_META_PREFIX
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
    const gate = parseReconciliationCandidateGate(row.reconciliation_gate);
    if (gate?.excludedTaskId === row.task_id) continue;
    if (gate !== null) candidateTime = Math.max(candidateTime, gate.nextAttemptAt);

    nextCheck = nextCheck === null ? candidateTime : Math.min(nextCheck, candidateTime);
  }

  if (nextCheck === null) return null;

  // Ensure we don't schedule in the past.
  return Math.max(nextCheck, now + minAlarmDelayMs);
}
