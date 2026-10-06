import { queryOptions } from '@tanstack/react-query';

import { getMyCredentialLimits, getProjectCredentialLimits } from '../api';

/**
 * Provider usage windows change on the order of minutes (one sample per agent
 * turn), so a short stale window plus a gentle poll keeps the chip honest
 * without a request per render. The poll pauses while the tab is hidden
 * (TanStack's default `refetchIntervalInBackground: false`).
 *
 * Env-configurable per rule 60; both values are read once at module load.
 */
const DEFAULT_CREDENTIAL_LIMITS_STALE_TIME_MS = 30_000;
const DEFAULT_CREDENTIAL_LIMITS_REFETCH_INTERVAL_MS = 60_000;

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CREDENTIAL_LIMITS_STALE_TIME_MS = envInt(
  import.meta.env.VITE_CREDENTIAL_LIMITS_STALE_TIME_MS,
  DEFAULT_CREDENTIAL_LIMITS_STALE_TIME_MS
);
export const CREDENTIAL_LIMITS_REFETCH_INTERVAL_MS = envInt(
  import.meta.env.VITE_CREDENTIAL_LIMITS_REFETCH_INTERVAL_MS,
  DEFAULT_CREDENTIAL_LIMITS_REFETCH_INTERVAL_MS
);

export const credentialLimitQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'credential-limits'] as const,
  mine: (queryScope: string) => [...credentialLimitQueryKeys.all(queryScope), 'mine'] as const,
  project: (queryScope: string, projectId: string, agentSessionId: string | null) =>
    [...credentialLimitQueryKeys.all(queryScope), 'project', projectId, agentSessionId] as const,
};

export function myCredentialLimitsQueryOptions(queryScope: string) {
  return queryOptions({
    queryKey: credentialLimitQueryKeys.mine(queryScope),
    queryFn: getMyCredentialLimits,
    staleTime: CREDENTIAL_LIMITS_STALE_TIME_MS,
    refetchInterval: CREDENTIAL_LIMITS_REFETCH_INTERVAL_MS,
  });
}

export function projectCredentialLimitsQueryOptions(
  queryScope: string,
  projectId: string,
  agentSessionId: string | null
) {
  return queryOptions({
    queryKey: credentialLimitQueryKeys.project(queryScope, projectId, agentSessionId),
    queryFn: () => getProjectCredentialLimits(projectId, { agentSessionId }),
    staleTime: CREDENTIAL_LIMITS_STALE_TIME_MS,
    refetchInterval: CREDENTIAL_LIMITS_REFETCH_INTERVAL_MS,
  });
}
