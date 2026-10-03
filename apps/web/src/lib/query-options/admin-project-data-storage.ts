import { queryOptions } from '@tanstack/react-query';

import {
  fetchAdminProjectDataArchiveCircuitBreakers,
  fetchAdminProjectDataArchiveProblemMigrations,
  fetchAdminProjectDataStorageTelemetry,
  fetchAdminProjectDataWallRecoveryConfig,
} from '../api';

export const adminProjectDataStorageQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'admin', 'project-data-storage'] as const,
  breakers: (queryScope: string, limit?: number) =>
    [
      ...adminProjectDataStorageQueryKeys.all(queryScope),
      'breakers',
      { limit: limit ?? null },
    ] as const,
  telemetry: (queryScope: string, limit?: number) =>
    [
      ...adminProjectDataStorageQueryKeys.all(queryScope),
      'telemetry',
      { limit: limit ?? null },
    ] as const,
  problemMigrations: (queryScope: string, limit?: number) =>
    [
      ...adminProjectDataStorageQueryKeys.all(queryScope),
      'problem-migrations',
      { limit: limit ?? null },
    ] as const,
  wallRecoveryConfig: (queryScope: string) =>
    [...adminProjectDataStorageQueryKeys.all(queryScope), 'wall-recovery-config'] as const,
};

export function adminProjectDataArchiveBreakersQueryOptions(queryScope: string, limit?: number) {
  return queryOptions({
    queryKey: adminProjectDataStorageQueryKeys.breakers(queryScope, limit),
    queryFn: () => fetchAdminProjectDataArchiveCircuitBreakers(limit),
  });
}

export function adminProjectDataStorageTelemetryQueryOptions(queryScope: string, limit?: number) {
  return queryOptions({
    queryKey: adminProjectDataStorageQueryKeys.telemetry(queryScope, limit),
    queryFn: () => fetchAdminProjectDataStorageTelemetry(limit),
  });
}

export function adminProjectDataArchiveProblemMigrationsQueryOptions(
  queryScope: string,
  limit?: number
) {
  return queryOptions({
    queryKey: adminProjectDataStorageQueryKeys.problemMigrations(queryScope, limit),
    queryFn: () => fetchAdminProjectDataArchiveProblemMigrations(limit),
  });
}

/** Ceilings and starting budgets for the wall recovery form; they only change on deploy. */
export function adminProjectDataWallRecoveryConfigQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: adminProjectDataStorageQueryKeys.wallRecoveryConfig(queryScope),
    queryFn: () => fetchAdminProjectDataWallRecoveryConfig(),
    staleTime: 5 * 60 * 1000,
  });
}
