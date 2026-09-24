import type {
  AdminProjectDataArchiveCircuitBreakerControlResponse,
  AdminProjectDataArchiveCircuitBreakersResponse,
  AdminProjectDataStorageTelemetryResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Admin ProjectData storage (Admin → Storage tab)
// =============================================================================

export async function fetchAdminProjectDataStorageTelemetry(
  limit?: number
): Promise<AdminProjectDataStorageTelemetryResponse> {
  const params = limit ? `?limit=${limit}` : '';
  return request<AdminProjectDataStorageTelemetryResponse>(
    `/api/admin/project-data/storage${params}`
  );
}

export async function fetchAdminProjectDataArchiveCircuitBreakers(
  limit?: number
): Promise<AdminProjectDataArchiveCircuitBreakersResponse> {
  const params = limit ? `?limit=${limit}` : '';
  return request<AdminProjectDataArchiveCircuitBreakersResponse>(
    `/api/admin/project-data/storage/archive-sharding/circuit-breakers${params}`
  );
}

export async function closeAdminProjectDataArchiveCircuitBreaker(
  projectId: string,
  reason: string
): Promise<AdminProjectDataArchiveCircuitBreakerControlResponse> {
  return request<AdminProjectDataArchiveCircuitBreakerControlResponse>(
    `/api/admin/project-data/storage/${encodeURIComponent(projectId)}/archive-sharding/circuit-breaker`,
    {
      method: 'POST',
      body: JSON.stringify({ state: 'closed', reason }),
    }
  );
}
