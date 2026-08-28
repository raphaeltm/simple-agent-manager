import type { ProjectDefaultCapacityPoolsResponse } from '@simple-agent-manager/shared';

import { request } from './client';

export function fetchProjectDefaultCapacityPools(
  projectId: string
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/capacity-pools/defaults`
  );
}

export function fetchUserDefaultCapacityPools(): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>('/api/capacity-pools/defaults');
}

export function reconcileUserDefaultCapacityPools(): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>('/api/capacity-pools/defaults/reconcile', {
    method: 'POST',
  });
}

export function fetchInstallationDefaultCapacityPools(): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>('/api/admin/capacity-pools/defaults');
}

export function reconcileInstallationDefaultCapacityPools(): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    '/api/admin/capacity-pools/defaults/reconcile',
    { method: 'POST' }
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
