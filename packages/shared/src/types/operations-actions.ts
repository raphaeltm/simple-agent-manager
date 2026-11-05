// =============================================================================
// Operations project: actions behind a server-side human approval
// (idea 01M6GGY1QPGG4D40HG0PVGQS3R)
// =============================================================================

/** Every action an Operations-project agent may request. */
export const OPERATIONS_ACTIONS = [
  'retry_snapshot',
  'rerun_node_cleanup',
  'sleep_session',
  'delete_workspace',
  'delete_node',
  'restart_vm_agent',
  'cancel_stuck_task',
] as const;
export type OperationsAction = (typeof OPERATIONS_ACTIONS)[number];

export type OperationsActionTargetType = 'node' | 'workspace' | 'chat_session' | 'task';

/** What each action acts on. The target ID an agent passes names one of these. */
export const OPERATIONS_ACTION_TARGET_TYPES: Record<OperationsAction, OperationsActionTargetType> =
  {
    retry_snapshot: 'chat_session',
    rerun_node_cleanup: 'node',
    sleep_session: 'chat_session',
    delete_workspace: 'workspace',
    delete_node: 'node',
    restart_vm_agent: 'node',
    cancel_stuck_task: 'task',
  };

/** Human labels for each action, shown in the approval notification and Admin → Approvals. */
export const OPERATIONS_ACTION_LABELS: Record<OperationsAction, string> = {
  retry_snapshot: 'Retry snapshot',
  rerun_node_cleanup: 'Re-run node cleanup',
  sleep_session: 'Sleep session',
  delete_workspace: 'Delete workspace',
  delete_node: 'Delete node',
  restart_vm_agent: 'Restart VM agent',
  cancel_stuck_task: 'Cancel stuck task',
};

/** Actions that cannot be undone; the approver is warned before tapping Approve. */
export const OPERATIONS_IRREVERSIBLE_ACTIONS: readonly OperationsAction[] = [
  'delete_workspace',
  'delete_node',
];

/**
 * Actions that run without a human tap when `operations.debuggerTools` is `read_auto_safe`
 * (the action matrix Raphaël approved on 2026-11-03). Every other action, and every action in
 * `read_ask`, needs a superadmin to approve it first.
 */
export const OPERATIONS_AUTO_SAFE_ACTIONS: readonly OperationsAction[] = [
  'retry_snapshot',
  'rerun_node_cleanup',
];

export const OPERATIONS_APPROVAL_STATUSES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'executed',
] as const;
export type OperationsApprovalStatus = (typeof OPERATIONS_APPROVAL_STATUSES)[number];

export const OPERATIONS_APPROVAL_DECISIONS = ['approve', 'deny'] as const;
export type OperationsApprovalDecision = (typeof OPERATIONS_APPROVAL_DECISIONS)[number];

export interface OperationsActionApproval {
  id: string;
  action: OperationsAction;
  targetType: OperationsActionTargetType;
  targetId: string;
  reason: string;
  evidenceSummary: string | null;
  /** Server-read facts about the target when the request was made (owner, status, names). */
  targetSummary: Record<string, string | number | boolean | null> | null;
  requestingProjectId: string;
  requestingTaskId: string;
  requestingSessionId: string | null;
  requesterUserId: string;
  status: OperationsApprovalStatus;
  autoApproved: boolean;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  executedAt: string | null;
  executionResult: Record<string, unknown> | null;
  createdAt: string;
}

export interface ListOperationsActionApprovalsResponse {
  approvals: OperationsActionApproval[];
}

export interface DecideOperationsActionApprovalRequest {
  decision: OperationsApprovalDecision;
  note?: string;
}

export interface DecideOperationsActionApprovalResponse {
  approval: OperationsActionApproval;
  /** Whether the decision prompt was queued to the requesting agent's session. */
  delivered: boolean;
}
