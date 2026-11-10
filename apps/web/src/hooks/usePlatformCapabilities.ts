import { useQuery } from '@tanstack/react-query';

import {
  ASSUMED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '../lib/api/platform-capabilities';
import { platformCapabilitiesQueryOptions } from '../lib/query-options/platform-capabilities';

/**
 * Which platform services this installation has, so entry points that cannot work here
 * (voice input, server read-aloud) are hidden. Every surface shares one cached query; until
 * it answers, every service is assumed present, which is how the app behaved before.
 */
export function usePlatformCapabilities(): PlatformCapabilities {
  const query = useQuery(platformCapabilitiesQueryOptions());
  return query.data ?? ASSUMED_PLATFORM_CAPABILITIES;
}
