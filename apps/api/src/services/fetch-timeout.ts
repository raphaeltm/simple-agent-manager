/**
 * Fetch wrapper with configurable timeout.
 *
 * Cloudflare Workers support `AbortController`/`AbortSignal` for fetch cancellation.
 * This utility adds a timeout that aborts the request if it exceeds the specified duration.
 */

const DEFAULT_API_TIMEOUT_MS = 30_000;

/**
 * Parse a timeout from env or return the default.
 */
export function getTimeoutMs(envValue: string | undefined, defaultMs: number = DEFAULT_API_TIMEOUT_MS): number {
  if (!envValue) return defaultMs;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return parsed;
}

/**
 * Fetch with an automatic timeout.
 * Aborts the request if it doesn't complete within `timeoutMs`.
 *
 * @param url - The URL to fetch
 * @param init - Standard RequestInit options
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @returns The fetch Response
 * @throws Error with "Request timed out" message on timeout
 */
export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
