import { useQuery } from '@tanstack/react-query';

import {
  ASSUMED_PLATFORM_CAPABILITIES,
  type PlatformCapabilities,
} from '../lib/api/platform-capabilities';
import { platformCapabilitiesQueryOptions } from '../lib/query-options/platform-capabilities';

/**
 * Which platform services this installation has, so entry points that cannot work here
 * (voice input, server read-aloud) are hidden. Every surface shares one cached query; until
 * it answers, and while it fails, every service is assumed present, which is how the app
 * behaved before. The project route prefetches it (lib/project-route-prefetch.ts).
 */
export function usePlatformCapabilities(): PlatformCapabilities {
  const query = useQuery(platformCapabilitiesQueryOptions());
  return query.data ?? ASSUMED_PLATFORM_CAPABILITIES;
}

/**
 * Whether agents can call Cloudflare-hosted models here. `known` stays false until the
 * capabilities answer arrives, so callers render as usual but hold the model catalog request
 * until then: an installation without Workers AI never asks for a catalog it cannot serve. A
 * failed capabilities query keeps the old behaviour (available); each catalog route still
 * refuses cleanly.
 */
export function useAgentModelCallsAvailable(): { available: boolean; known: boolean } {
  const query = useQuery(platformCapabilitiesQueryOptions());
  if (query.isError) return { available: true, known: true };
  if (!query.data) return { available: true, known: false };
  return { available: query.data.agentModelCalls, known: true };
}
