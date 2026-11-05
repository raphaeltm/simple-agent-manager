import type { OperationsApprovalDecision } from '@simple-agent-manager/shared';
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

/** Approve or deny one approval, then refresh every approvals query for this user. */
export function useDecideOperationsApproval(scope: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: OperationsApprovalDecision }) =>
      decideOperationsApproval(input.id, input.decision),
    onSettled: () => queryClient.invalidateQueries({ queryKey: operationsApprovalKeys.all(scope) }),
  });
}
