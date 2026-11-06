/**
 * Delivers a superadmin's approve/deny decision to the session of the agent that asked, as a
 * new durable prompt (source kind `operations_decision`). The delivery is guarded on the
 * requesting task's stable authority, so it wakes the session only while that task, or its
 * own session-recovery successor, is still live (`sourceTaskGuardForClaim`).
 *
 * The prompt is a notice, never the approval: `ops_execute_action` re-checks the server-side
 * record, so a forged or replayed prompt cannot authorize anything.
 */
import { OPERATIONS_ACTION_TARGET_TYPES } from '@simple-agent-manager/shared';

import { resolveDurableExecutionConfig } from '../../durable-objects/project-data/durable-execution-config';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../project-data';
import { operationsDecisionNotice, safeNotice } from '../sam-notice-builders';
import type { StoredOperationsApproval } from './approvals';

export function operationsDecisionDeliveryId(approvalId: string): string {
  return `operations-decision:${approvalId}`;
}

export function buildOperationsDecisionPrompt(approval: StoredOperationsApproval): string {
  const target = `${OPERATIONS_ACTION_TARGET_TYPES[approval.action]} ${approval.targetId}`;
  if (approval.status === 'approved') {
    return [
      `Operations action approved: ${approval.action} on ${target} (approval ${approval.id}).`,
      `Run it once with ops_execute_action using approvalId "${approval.id}", action "${approval.action}" and targetId "${approval.targetId}" before ${approval.expiresAt}.`,
      approval.decisionNote ? `Approver's note: ${approval.decisionNote}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    `Operations action denied: ${approval.action} on ${target} (approval ${approval.id}). Do not run it.`,
    approval.decisionNote ? `Approver's note: ${approval.decisionNote}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Best-effort; returns whether the prompt was queued. Never throws. */
export async function deliverOperationsDecision(
  env: Env,
  approval: StoredOperationsApproval
): Promise<boolean> {
  if (!approval.requestingSessionId) return false;
  const config = resolveDurableExecutionConfig(env);
  if (!config.deliveryEnabled) {
    log.warn('operations_actions.decision_delivery_disabled', { approvalId: approval.id });
    return false;
  }
  const content = buildOperationsDecisionPrompt(approval);
  try {
    await projectDataService.acceptPromptDelivery(env, approval.requestingProjectId, {
      deliveryId: operationsDecisionDeliveryId(approval.id),
      targetSessionId: approval.requestingSessionId,
      displayContent: content,
      deliveryContent: content,
      sourceTaskId: approval.requestingAuthorityTaskId,
      senderType: 'system',
      senderId: approval.decidedBy,
      messageClass: 'deliver',
      sourceKind: 'operations_decision',
      ttlMs: config.ttlMs,
      metadata: {
        approvalId: approval.id,
        decision: approval.status,
        action: approval.action,
        targetId: approval.targetId,
      },
      notice: safeNotice(() => operationsDecisionNotice(approval), { approvalId: approval.id }),
    });
    return true;
  } catch (error) {
    log.error('operations_actions.decision_delivery_failed', {
      approvalId: approval.id,
      projectId: approval.requestingProjectId,
      sessionId: approval.requestingSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
