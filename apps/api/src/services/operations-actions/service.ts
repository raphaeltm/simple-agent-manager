/**
 * Operations actions behind a server-side human approval (idea 01M6GGY1QPGG4D40HG0PVGQS3R).
 *
 *   ops_request_action  -> requestOperationsAction  (record + notify the superadmin owner)
 *   superadmin decision -> decideOperationsAction   (CAS pending -> approved | denied, then
 *                                                    deliver the decision as a new prompt)
 *   ops_execute_action  -> executeOperationsAction  (CAS approved -> executed, then run once)
 *
 * The approval lives in D1, not in a chat answer: `request_human_input` returns free text, so
 * an agent, or a prompt injection in a log line it read, could claim an approval it never got.
 *
 * Callers pass the grant `requireOperationsAccess(..., { capability: 'act' })` returned for the
 * current call; this module never re-derives access from the token. The MCP runner
 * (`runOpsActTool`) audits each tool call with its approval ID; the decision, which is not an
 * MCP call, is audited here.
 */
import {
  OPERATIONS_ACTIONS,
  OPERATIONS_AUTO_SAFE_ACTIONS,
  type OperationsAction,
  type OperationsApprovalDecision,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { sendNotification } from '../notification';
import {
  type OperationsAccessContext,
  type OperationsToolsMode,
  recordOperationsAudit,
} from '../operations-access';
import { resolveOperationsTelemetrySetting } from '../operations-telemetry-settings';
import {
  claimApprovalForExecution,
  createApproval,
  decideApproval,
  type ExecutionRefusal,
  recordExecutionResult,
  type StoredOperationsApproval,
} from './approvals';
import { deliverOperationsDecision } from './decision-delivery';
import { type ActionExecutionResult, executeAction } from './executors';
import { resolveActionTarget, summarizeTarget } from './targets';

/** A caller mistake the agent can fix (unknown action, missing target, refused ticket). */
export class OperationsActionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_action' | 'target_not_found' | 'task_not_found' | ExecutionRefusal
  ) {
    super(message);
    this.name = 'OperationsActionError';
  }
}

export function isOperationsAction(value: unknown): value is OperationsAction {
  return typeof value === 'string' && (OPERATIONS_ACTIONS as readonly string[]).includes(value);
}

/**
 * The approved action matrix: in `read_auto_safe` only the auto-safe actions skip the human
 * tap; in `read_ask` every action needs one. (`off` and `read` never reach here: the gate
 * refuses capability `act`.)
 */
export function actionRequiresApproval(
  mode: OperationsToolsMode,
  action: OperationsAction
): boolean {
  return !(mode === 'read_auto_safe' && OPERATIONS_AUTO_SAFE_ACTIONS.includes(action));
}

/** The task's chat and stable source-task authority (`recovery_source_task_id ?? id`). */
async function loadTaskAuthority(
  env: Env,
  grant: OperationsAccessContext
): Promise<{ authorityTaskId: string; chatSessionId: string | null }> {
  const row = await env.DATABASE.prepare(
    `SELECT id, chat_session_id, recovery_source_task_id FROM tasks WHERE id = ? AND project_id = ?`
  )
    .bind(grant.taskId, grant.projectId)
    .first<{
      id: string;
      chat_session_id: string | null;
      recovery_source_task_id: string | null;
    }>();
  if (!row) {
    throw new OperationsActionError(
      `Task ${grant.taskId} was not found in this project`,
      'task_not_found'
    );
  }
  return {
    authorityTaskId: row.recovery_source_task_id ?? row.id,
    chatSessionId: row.chat_session_id,
  };
}

const ACTION_LABELS: Record<OperationsAction, string> = {
  retry_snapshot: 'Retry snapshot',
  rerun_node_cleanup: 'Re-run node cleanup',
  sleep_session: 'Sleep session',
  delete_workspace: 'Delete workspace',
  delete_node: 'Delete node',
  restart_vm_agent: 'Restart VM agent',
  cancel_stuck_task: 'Cancel stuck task',
};

async function notifyApprover(env: Env, approval: StoredOperationsApproval): Promise<void> {
  try {
    await sendNotification(env, approval.requesterUserId, {
      projectId: approval.requestingProjectId,
      taskId: approval.requestingTaskId,
      sessionId: approval.requestingSessionId,
      type: 'operations_approval',
      urgency: 'high',
      title: `Approve: ${ACTION_LABELS[approval.action]} ${approval.targetId}?`,
      body: approval.reason.slice(0, 500),
      actionUrl: `/admin/approvals?approval=${encodeURIComponent(approval.id)}`,
      metadata: {
        approvalId: approval.id,
        action: approval.action,
        targetType: approval.targetType,
        targetId: approval.targetId,
      },
    });
  } catch (error) {
    // The record is the approval; a lost notification still shows on Admin -> Approvals.
    log.error('operations_actions.notify_failed', {
      approvalId: approval.id,
      userId: approval.requesterUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface RequestActionInput {
  action: OperationsAction;
  targetId: string;
  reason: string;
  evidence: string | null;
}

export async function requestOperationsAction(
  env: Env,
  grant: OperationsAccessContext,
  input: RequestActionInput
): Promise<StoredOperationsApproval> {
  const target = await resolveActionTarget(env, grant, input.action, input.targetId);
  if (!target) {
    throw new OperationsActionError(
      `Target ${input.targetId} for ${input.action} was not found`,
      'target_not_found'
    );
  }
  const { authorityTaskId, chatSessionId } = await loadTaskAuthority(env, grant);
  const autoApproved = !actionRequiresApproval(grant.mode, input.action);
  const approval = await createApproval(env.DATABASE, {
    action: input.action,
    targetId: input.targetId,
    reason: input.reason,
    evidenceSummary: input.evidence,
    targetSummary: summarizeTarget(target),
    requestingProjectId: grant.projectId,
    requestingTaskId: grant.taskId,
    requestingAuthorityTaskId: authorityTaskId,
    requestingSessionId: chatSessionId,
    requesterUserId: grant.userId,
    autoApproved,
    ttlMs: await resolveOperationsTelemetrySetting(env, 'actionApprovalTtlMs'),
  });
  if (!autoApproved) await notifyApprover(env, approval);
  return approval;
}

export type DecideActionOutcome =
  | { outcome: 'decided'; approval: StoredOperationsApproval; delivered: boolean }
  | { outcome: 'not_found' }
  | { outcome: 'expired' | 'already_decided'; approval: StoredOperationsApproval };

/** Called by the superadmin decision route; the route has already required a superadmin. */
export async function decideOperationsAction(
  env: Env,
  input: {
    approvalId: string;
    decision: OperationsApprovalDecision;
    deciderUserId: string;
    note: string | null;
  }
): Promise<DecideActionOutcome> {
  const result = await decideApproval(env.DATABASE, {
    id: input.approvalId,
    decision: input.decision,
    deciderUserId: input.deciderUserId,
    note: input.note,
    ttlMs: await resolveOperationsTelemetrySetting(env, 'actionApprovalTtlMs'),
  });
  if (result.outcome !== 'decided') return result;
  await recordOperationsAudit(env, {
    actorUserId: input.deciderUserId,
    taskId: result.approval.requestingTaskId,
    tool: 'operations_approval_decision',
    targetType: result.approval.targetType,
    targetId: result.approval.targetId,
    outcome: result.approval.status,
    approvalId: result.approval.id,
    detail: { action: result.approval.action },
  });
  const delivered = await deliverOperationsDecision(env, result.approval);
  return { ...result, delivered };
}

const REFUSAL_MESSAGES: Record<ExecutionRefusal, string> = {
  not_found: 'No approval with this ID exists',
  other_task: 'This approval was requested by a different task',
  action_mismatch: 'This approval is for a different action',
  target_mismatch: 'This approval is for a different target',
  not_approved: 'This approval has not been decided yet; wait for the decision prompt',
  denied: 'This approval was denied',
  expired: 'This approval has expired; request the action again',
  already_executed: 'This approval was already executed; each approval runs once',
};

export interface ExecuteActionInput {
  approvalId: string;
  action: OperationsAction;
  targetId: string;
}

export interface ExecuteActionOutcome {
  approval: StoredOperationsApproval;
  result: ActionExecutionResult;
}

/**
 * Claims the approval (the single-use CAS), re-resolves the target, and runs the action once.
 * A refused claim throws `OperationsActionError` naming the refusal.
 */
export async function executeOperationsAction(
  env: Env,
  grant: OperationsAccessContext,
  input: ExecuteActionInput
): Promise<ExecuteActionOutcome> {
  const { authorityTaskId } = await loadTaskAuthority(env, grant);
  const claim = await claimApprovalForExecution(env.DATABASE, {
    id: input.approvalId,
    action: input.action,
    targetId: input.targetId,
    projectId: grant.projectId,
    authorityTaskId,
  });
  if (!claim.claimed) {
    throw new OperationsActionError(REFUSAL_MESSAGES[claim.refusal], claim.refusal);
  }

  const target = await resolveActionTarget(env, grant, input.action, input.targetId);
  const result: ActionExecutionResult = target
    ? await executeAction(env, grant, input.action, target)
    : { status: 'failed', message: `Target ${input.targetId} no longer exists` };
  await recordExecutionResult(env.DATABASE, claim.approval.id, { ...result });
  return { approval: { ...claim.approval, executionResult: { ...result } }, result };
}
