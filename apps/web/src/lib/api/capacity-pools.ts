import type {
  DefaultCapacityPoolUpdateRequest,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';

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

export function updateUserDefaultCapacityPools(
  body: DefaultCapacityPoolUpdateRequest
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>('/api/capacity-pools/defaults', {
    method: 'PATCH',
    body: JSON.stringify(body),
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

export function updateInstallationDefaultCapacityPools(
  body: DefaultCapacityPoolUpdateRequest
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>('/api/admin/capacity-pools/defaults', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function reconcileProjectDefaultCapacityPools(
  projectId: string
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/capacity-pools/defaults/reconcile`,
    { method: 'POST' }
  );
}

export function updateProjectDefaultCapacityPools(
  projectId: string,
  body: DefaultCapacityPoolUpdateRequest
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/capacity-pools/defaults`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    }
  );
}
