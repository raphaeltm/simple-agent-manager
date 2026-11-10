import { request } from './client';

/** Mirrors `PublicPlatformCapabilities` in apps/api/src/services/platform-capabilities.ts. */
export interface PlatformCapabilities {
  speechToText: boolean;
  textToSpeech: boolean;
}

/**
 * Assumed until the API answers, and when it cannot: every service present. That is how the
 * app behaved before the endpoint existed, and each API route still refuses cleanly on an
 * installation that lacks the service.
 */
export const ASSUMED_PLATFORM_CAPABILITIES: PlatformCapabilities = Object.freeze({
  speechToText: true,
  textToSpeech: true,
});

/** Which platform services this installation has (`GET /api/config/platform-capabilities`). */
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
    if (signal?.aborted) throw error;
    return ASSUMED_PLATFORM_CAPABILITIES;
  }
}
