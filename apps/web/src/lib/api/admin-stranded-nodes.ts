import type {
  ListAdminStrandedNodesResponse,
  OperatorNodeDeletionRequest,
} from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Stuck nodes on SAM's capacity (Admin → Infrastructure)
// =============================================================================

export async function fetchAdminStrandedNodes(
  signal?: AbortSignal
): Promise<ListAdminStrandedNodesResponse> {
  return request<ListAdminStrandedNodesResponse>('/api/admin/nodes/stranded', { signal });
}

export async function attestOperatorNodeDeletion(
  nodeId: string,
  body: OperatorNodeDeletionRequest
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/api/admin/nodes/${encodeURIComponent(nodeId)}/operator-deletion`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}
