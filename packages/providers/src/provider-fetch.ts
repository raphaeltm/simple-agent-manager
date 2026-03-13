import { ProviderError } from './types';

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Parse a timeout from an env value string or return the default.
 */
export function getTimeoutMs(
  envValue: string | undefined,
  defaultMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): number {
  if (!envValue) return defaultMs;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return parsed;
}

/**
 * Fetch wrapper for provider API calls.
 * Adds configurable timeout via AbortController and wraps errors into ProviderError.
 *
 * @param providerName - Provider identifier for error context
 * @param url - The URL to fetch
 * @param init - Standard RequestInit options
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @returns The fetch Response
 * @throws ProviderError on HTTP errors, timeouts, and network failures
 */
export async function providerFetch(
  providerName: string,
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorMessage: string;
      try {
        const body = await response.text();
        // Try parsing as JSON for structured error messages
        try {
          const json = JSON.parse(body) as { error?: { message?: string }; message?: string };
          errorMessage = json.error?.message || json.message || body;
        } catch {
          errorMessage = body || `HTTP ${response.status}`;
        }
      } catch {
        errorMessage = `HTTP ${response.status}`;
      }

      throw new ProviderError(
        providerName,
        response.status,
        `${providerName} API error (${response.status}): ${errorMessage}`,
      );
    }

    return response;
  } catch (err) {
    if (err instanceof ProviderError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(
        providerName,
        undefined,
        `${providerName} API request timed out after ${timeoutMs}ms: ${url}`,
        { cause: err },
      );
    }

    throw new ProviderError(
      providerName,
      undefined,
      `${providerName} API request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
