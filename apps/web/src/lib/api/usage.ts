import type { ComputeUsageResponse } from '@simple-agent-manager/shared';

import { request } from './client';

/** Fetch current user's compute usage for the current billing period. */
export async function fetchComputeUsage(): Promise<ComputeUsageResponse> {
  return request<ComputeUsageResponse>('/api/usage/compute');
}
