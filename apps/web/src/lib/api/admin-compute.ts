import { request } from './client';

// =============================================================================
// Admin Compute Usage
// =============================================================================

export type {
  AdminComputeUsageResponse,
  AdminUserDetailedUsage,
} from '@simple-agent-manager/shared';

export async function fetchAdminComputeUsage(): Promise<
  import('@simple-agent-manager/shared').AdminComputeUsageResponse
> {
  return request('/api/admin/usage/compute');
}

export async function fetchAdminUserComputeUsage(
  userId: string
): Promise<import('@simple-agent-manager/shared').AdminUserDetailedUsage> {
  return request(`/api/admin/usage/compute/${userId}`);
}

// =============================================================================
// Admin Node Usage
// =============================================================================

export type {
  AdminNodeUsageResponse,
  AdminUserNodeDetailedUsage,
} from '@simple-agent-manager/shared';

export async function fetchAdminNodeUsage(
  signal?: AbortSignal
): Promise<import('@simple-agent-manager/shared').AdminNodeUsageResponse> {
  return request('/api/admin/usage/nodes', { signal });
}

export async function fetchAdminUserNodeUsage(
  userId: string,
  signal?: AbortSignal
): Promise<import('@simple-agent-manager/shared').AdminUserNodeDetailedUsage> {
  return request(`/api/admin/usage/nodes/${userId}`, { signal });
}

// =============================================================================
// Admin Compute Quotas
// =============================================================================

export type {
  AdminDefaultQuotaResponse,
  AdminUserQuotasListResponse,
  AdminUserQuotaSummary,
  AdminUserResolvedQuota,
} from '@simple-agent-manager/shared';

export async function fetchAdminDefaultQuota(): Promise<
  import('@simple-agent-manager/shared').AdminDefaultQuotaResponse
> {
  return request('/api/admin/quotas/default');
}

export async function updateAdminDefaultQuota(
  monthlyVcpuHoursLimit: number | null
): Promise<import('@simple-agent-manager/shared').AdminDefaultQuotaResponse> {
  return request('/api/admin/quotas/default', {
    method: 'PUT',
    body: JSON.stringify({ monthlyVcpuHoursLimit }),
  });
}

export async function fetchAdminUserQuotas(
  signal?: AbortSignal
): Promise<import('@simple-agent-manager/shared').AdminUserQuotasListResponse> {
  return request('/api/admin/quotas/users', { signal });
}

export async function fetchAdminUserQuota(
  userId: string
): Promise<import('@simple-agent-manager/shared').AdminUserResolvedQuota> {
  return request(`/api/admin/quotas/users/${userId}`);
}

export async function updateAdminUserQuota(
  userId: string,
  monthlyVcpuHoursLimit: number | null
): Promise<{
  userId: string;
  monthlyVcpuHoursLimit: number | null;
  source: string;
  currentUsage: number;
  remaining: number | null;
}> {
  return request(`/api/admin/quotas/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ monthlyVcpuHoursLimit }),
  });
}

export async function removeAdminUserQuota(userId: string): Promise<{ success: boolean }> {
  return request(`/api/admin/quotas/users/${userId}`, { method: 'DELETE' });
}
