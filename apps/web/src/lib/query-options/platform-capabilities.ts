import { queryOptions } from '@tanstack/react-query';

import { getPlatformCapabilities } from '../api/platform-capabilities';
import { PLATFORM_CAPABILITIES_STALE_TIME_MS } from '../query-stale-times';

/**
 * Public, identical for every visitor (the endpoint needs no session), so the key is not
 * auth-scoped and is never persisted (persistence requires the `['auth', scope, …]` shape).
 */
export const platformCapabilitiesQueryKeys = {
  all: () => ['public-config', 'platform-capabilities'] as const,
};

/** Deployment-level facts: they change only when the installation is reconfigured. */
export function platformCapabilitiesQueryOptions() {
  return queryOptions({
    queryKey: platformCapabilitiesQueryKeys.all(),
    queryFn: ({ signal }) => getPlatformCapabilities(signal),
    staleTime: PLATFORM_CAPABILITIES_STALE_TIME_MS,
  });
}
