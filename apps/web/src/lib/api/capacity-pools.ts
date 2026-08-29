import type {
  DefaultCapacityPoolUpdateRequest,
  ProjectDefaultCapacityPoolsResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

interface DefaultCapacityPoolsFetchOptions {
  ensure?: boolean;
}

function defaultCapacityPoolsPath(path: string, options?: DefaultCapacityPoolsFetchOptions): string {
  if (!options?.ensure) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}ensure=true`;
}

export function fetchProjectDefaultCapacityPools(
  projectId: string,
  options?: DefaultCapacityPoolsFetchOptions
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    defaultCapacityPoolsPath(
      `/api/projects/${encodeURIComponent(projectId)}/capacity-pools/defaults`,
      options
    )
  );
}

export function fetchUserDefaultCapacityPools(
  options?: DefaultCapacityPoolsFetchOptions
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    defaultCapacityPoolsPath('/api/capacity-pools/defaults', options)
  );
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

export function fetchInstallationDefaultCapacityPools(
  options?: DefaultCapacityPoolsFetchOptions
): Promise<ProjectDefaultCapacityPoolsResponse> {
  return request<ProjectDefaultCapacityPoolsResponse>(
    defaultCapacityPoolsPath('/api/admin/capacity-pools/defaults', options)
  );
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
