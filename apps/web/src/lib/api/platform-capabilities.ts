import { request } from './client';

/** Mirrors `PublicPlatformCapabilities` in apps/api/src/services/platform-capabilities.ts. */
export interface PlatformCapabilities {
  speechToText: boolean;
  textToSpeech: boolean;
  guidedCredentialSetup: boolean;
  analytics: boolean;
  workerLogSearch: boolean;
  artifacts: boolean;
  emailSending: boolean;
}

/**
 * Assumed until the API answers, and when it cannot: every service present. That is how the
 * app behaved before the endpoint existed, and each API route still refuses cleanly on an
 * installation that lacks the service.
 */
export const ASSUMED_PLATFORM_CAPABILITIES: PlatformCapabilities = Object.freeze({
  speechToText: true,
  textToSpeech: true,
  guidedCredentialSetup: true,
  analytics: true,
  workerLogSearch: true,
  artifacts: true,
  emailSending: true,
});

/** Which platform services this installation has (`GET /api/config/platform-capabilities`). */
export async function getPlatformCapabilities(signal?: AbortSignal): Promise<PlatformCapabilities> {
  try {
    const result = await request<Partial<PlatformCapabilities>>(
      '/api/config/platform-capabilities',
      { signal }
    );
    return {
      ...ASSUMED_PLATFORM_CAPABILITIES,
      ...Object.fromEntries(
        Object.entries(result).filter(([, value]) => typeof value === 'boolean')
      ),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return ASSUMED_PLATFORM_CAPABILITIES;
  }
}
