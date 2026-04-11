import type { ComputeUsageResponse, UserQuotaStatusResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/** Fetch current user's compute usage for the current billing period. */
export async function fetchComputeUsage(): Promise<ComputeUsageResponse> {
  return request<ComputeUsageResponse>('/api/usage/compute');
}

/** Fetch current user's quota status. */
export async function fetchUserQuotaStatus(): Promise<UserQuotaStatusResponse> {
  return request<UserQuotaStatusResponse>('/api/usage/quota');
}
