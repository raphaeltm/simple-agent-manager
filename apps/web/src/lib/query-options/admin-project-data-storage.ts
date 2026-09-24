import { queryOptions } from '@tanstack/react-query';

import {
  fetchAdminProjectDataArchiveCircuitBreakers,
  fetchAdminProjectDataArchiveProblemMigrations,
  fetchAdminProjectDataStorageTelemetry,
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
