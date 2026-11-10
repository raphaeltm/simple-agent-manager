import { ApiClientError, request } from './client';

/** Mirrors `PublicPlatformCapabilities` in apps/api/src/services/platform-capabilities.ts. */
export interface PlatformCapabilities {
  speechToText: boolean;
  textToSpeech: boolean;
  /** Whether a monthly AI dollar cap can be set (needs Cloudflare AI Gateway). */
  monthlyCostCap: boolean;
}

/**
 * Assumed until the API answers, and when it cannot: every service present. That is how the
 * app behaved before the endpoint existed, and each API route still refuses cleanly on an
 * installation that lacks the service.
 */
export const ASSUMED_PLATFORM_CAPABILITIES: PlatformCapabilities = Object.freeze({
  speechToText: true,
  textToSpeech: true,
  monthlyCostCap: true,
});

/**
 * Which platform services this installation has (`GET /api/config/platform-capabilities`).
 * An API that predates the endpoint (404) has every service, so that is an answer. Any other
 * failure throws: the hook keeps assuming every service meanwhile, and the query retries
 * instead of caching a guess for its whole stale time.
 */
export async function getPlatformCapabilities(signal?: AbortSignal): Promise<PlatformCapabilities> {
  try {
    const result = await request<Partial<PlatformCapabilities>>(
      '/api/config/platform-capabilities',
      { signal }
    );
    // Known keys only; a field the API omits or mistypes keeps its assumed value.
    const capabilities = { ...ASSUMED_PLATFORM_CAPABILITIES };
    for (const key of Object.keys(capabilities) as (keyof PlatformCapabilities)[]) {
      const value: unknown = result[key];
      if (typeof value === 'boolean') capabilities[key] = value;
    }
    return capabilities;
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return ASSUMED_PLATFORM_CAPABILITIES;
    }
    throw error;
  }
}
