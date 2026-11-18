import { ApiClientError, request } from './client';

/** Mirrors `PublicPlatformCapabilities` in apps/api/src/services/platform-capabilities.ts. */
export interface PlatformCapabilities {
  /** Voice input (mic) in the chat, comment and SAM composers. */
  speechToText: boolean;
  /** Server read-aloud on agent messages and task summaries. */
  textToSpeech: boolean;
  /** Admin → Logs search (Workers Observability). False where logs are read on the server. */
  logSearch: boolean;
  /** Admin → Stream (tail worker). False where no tail worker feeds it. */
  liveLogStream: boolean;
  /** Whether agents can call Cloudflare-hosted models (needs Workers AI). */
  agentModelCalls: boolean;
}

/**
 * Assumed until the API answers, and when it cannot: every service present. That is how the
 * app behaved before the endpoint existed, and each API route still refuses cleanly on an
 * installation that lacks the service.
 */
export const ASSUMED_PLATFORM_CAPABILITIES: PlatformCapabilities = Object.freeze({
  speechToText: true,
  textToSpeech: true,
  logSearch: true,
  liveLogStream: true,
  agentModelCalls: true,
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
