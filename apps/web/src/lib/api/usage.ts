import type { ComputeUsageResponse, UserAiUsageResponse, UserQuotaStatusResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/** Fetch current user's compute usage for the current billing period. */
export async function fetchComputeUsage(): Promise<ComputeUsageResponse> {
  return request<ComputeUsageResponse>('/api/usage/compute');
}

/** Fetch current user's quota status. */
export async function fetchUserQuotaStatus(): Promise<UserQuotaStatusResponse> {
  return request<UserQuotaStatusResponse>('/api/usage/quota');
}

/** Fetch current user's SAM-managed AI Gateway LLM usage. */
export async function fetchUserAiUsage(period: string = 'current-month'): Promise<UserAiUsageResponse> {
  return request<UserAiUsageResponse>(`/api/usage/ai?period=${encodeURIComponent(period)}`);
}
