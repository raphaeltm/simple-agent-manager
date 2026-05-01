import type {
  ComputeUsageResponse,
  UpdateAiBudgetRequest,
  UserAiBudgetResponse,
  UserAiUsageResponse,
  UserQuotaStatusResponse,
} from '@simple-agent-manager/shared';

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

/** Fetch current user's AI budget settings + utilization. */
export async function fetchUserAiBudget(): Promise<UserAiBudgetResponse> {
  return request<UserAiBudgetResponse>('/api/usage/ai/budget');
}

/** Update current user's AI budget settings. */
export async function updateUserAiBudget(body: UpdateAiBudgetRequest): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/usage/ai/budget', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
