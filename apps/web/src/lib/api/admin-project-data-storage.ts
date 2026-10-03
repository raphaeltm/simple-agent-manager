import type {
  AdminProjectDataArchiveCircuitBreakerControlResponse,
  AdminProjectDataArchiveCircuitBreakersResponse,
  AdminProjectDataArchiveMigrationAbandonResponse,
  AdminProjectDataArchiveProblemMigrationsResponse,
  AdminProjectDataStorageTelemetryResponse,
  GroupedFtsWallRecoveryConfigResponse,
  GroupedFtsWallRecoveryRequest,
  GroupedFtsWallRecoveryResponse,
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

export async function fetchAdminProjectDataArchiveProblemMigrations(
  limit?: number
): Promise<AdminProjectDataArchiveProblemMigrationsResponse> {
  const params = limit ? `?limit=${limit}` : '';
  return request<AdminProjectDataArchiveProblemMigrationsResponse>(
    `/api/admin/project-data/storage/archive-sharding/problem-migrations${params}`
  );
}

export async function abandonAdminProjectDataArchiveMigration(
  projectId: string,
  migrationId: string,
  reason: string
): Promise<AdminProjectDataArchiveMigrationAbandonResponse> {
  return request<AdminProjectDataArchiveMigrationAbandonResponse>(
    `/api/admin/project-data/storage/${encodeURIComponent(projectId)}/archive-sharding/migrations/${encodeURIComponent(migrationId)}/abandon`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
}

export async function fetchAdminProjectDataWallRecoveryConfig(): Promise<GroupedFtsWallRecoveryConfigResponse> {
  return request<GroupedFtsWallRecoveryConfigResponse>(
    '/api/admin/project-data/storage/grouped-fts-wall-recovery/config'
  );
}

/** Superadmin grouped-FTS wall recovery for one project; `dryRun` previews without changes. */
export async function runAdminProjectDataWallRecovery(
  projectId: string,
  body: GroupedFtsWallRecoveryRequest
): Promise<GroupedFtsWallRecoveryResponse> {
  return request<GroupedFtsWallRecoveryResponse>(
    `/api/admin/project-data/storage/${encodeURIComponent(projectId)}/grouped-fts-wall-recovery`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
}
