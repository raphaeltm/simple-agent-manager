import type { ProjectDefaultCapacityPoolsResponse } from '@simple-agent-manager/shared';

import { request } from './client';

export function fetchProjectDefaultCapacityPools(
  projectId: string
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/capacity-pools/defaults`
  );
}

export function reconcileProjectDefaultCapacityPools(
  projectId: string
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/capacity-pools/defaults/reconcile`,
    { method: 'POST' }
  );
}
