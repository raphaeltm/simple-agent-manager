import type {
  GetOperationsActionApprovalResponse,
  OperationsApprovalDecision,
} from '@simple-agent-manager/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { decideOperationsApproval } from '../../lib/api';

/**
 * Query keys for Operations approvals. The list (Admin → Approvals) and each single approval
 * (the in-chat card) share the prefix, so one invalidation refreshes both surfaces.
 */
export const operationsApprovalKeys = {
  all: (scope: string) => ['auth', scope, 'admin', 'operations-approvals'] as const,
  detail: (scope: string, approvalId: string) =>
    [...operationsApprovalKeys.all(scope), approvalId] as const,
};

/**
 * Approve or deny one approval. The returned record is written to the detail cache at once, so a
 * card shows the decided status even if the follow-up refetch fails; then every approvals query
 * for this user is refreshed.
 */
export function useDecideOperationsApproval(scope: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: OperationsApprovalDecision }) =>
      decideOperationsApproval(input.id, input.decision),
    onSuccess: (response) =>
      queryClient.setQueryData<GetOperationsActionApprovalResponse>(
        operationsApprovalKeys.detail(scope, response.approval.id),
        { approval: response.approval }
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: operationsApprovalKeys.all(scope) }),
  });
}
