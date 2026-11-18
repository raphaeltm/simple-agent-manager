import type {
  DecideOperationsActionApprovalResponse,
  GetOperationsActionApprovalResponse,
  ListOperationsActionApprovalsResponse,
  OperationsApprovalDecision,
} from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Operations action approvals (Admin → Approvals tab and the in-chat approval card)
// =============================================================================

export async function fetchOperationsApprovals(
  signal?: AbortSignal
): Promise<ListOperationsActionApprovalsResponse> {
  return request<ListOperationsActionApprovalsResponse>('/api/admin/operations/approvals', {
    signal,
  });
}

export async function fetchOperationsApproval(
  approvalId: string,
  signal?: AbortSignal
): Promise<GetOperationsActionApprovalResponse> {
  return request<GetOperationsActionApprovalResponse>(
    `/api/admin/operations/approvals/${encodeURIComponent(approvalId)}`,
    { signal }
  );
}

export async function decideOperationsApproval(
  approvalId: string,
  decision: OperationsApprovalDecision
): Promise<DecideOperationsActionApprovalResponse> {
  return request<DecideOperationsActionApprovalResponse>(
    `/api/admin/operations/approvals/${encodeURIComponent(approvalId)}/decision`,
    { method: 'POST', body: JSON.stringify({ decision }) }
  );
}
