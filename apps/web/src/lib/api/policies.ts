/**
 * Project Policies API client functions.
 */
import type { ListPoliciesResponse, ProjectPolicy, UpdatePolicyRequest } from '@simple-agent-manager/shared';

import { request } from './client';

export type { ListPoliciesResponse, ProjectPolicy };

export async function listPolicies(
  projectId: string,
  params: { category?: string; includeInactive?: boolean; limit?: number; offset?: number } = {},
): Promise<ListPoliciesResponse> {
  const searchParams = new URLSearchParams();
  if (params.category) searchParams.set('category', params.category);
  if (params.includeInactive) searchParams.set('includeInactive', 'true');
  if (params.limit) searchParams.set('limit', String(params.limit));
  if (params.offset) searchParams.set('offset', String(params.offset));
  const query = searchParams.toString();
  const endpoint = query
    ? `/api/projects/${projectId}/policies?${query}`
    : `/api/projects/${projectId}/policies`;
  return request<ListPoliciesResponse>(endpoint);
}

export async function getPolicy(
  projectId: string,
  policyId: string,
): Promise<ProjectPolicy> {
  return request<ProjectPolicy>(`/api/projects/${projectId}/policies/${policyId}`);
}


export async function updatePolicy(
  projectId: string,
  policyId: string,
  body: UpdatePolicyRequest,
): Promise<{ updated: boolean; policyId: string }> {
  return request(`/api/projects/${projectId}/policies/${policyId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deletePolicy(
  projectId: string,
  policyId: string,
): Promise<{ removed: boolean; policyId: string }> {
  return request(`/api/projects/${projectId}/policies/${policyId}`, {
    method: 'DELETE',
  });
}
