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
 * The URL as it may appear in an error message. The query string and fragment are dropped
 * because they can carry tokens (VM agent `?token=`, presigned signatures), and callers log
 * these messages.
 */
function urlWithoutQuery(url: string | URL): string {
  const text = url.toString();
  const end = text.search(/[?#]/);
  return end === -1 ? text : text.slice(0, end);
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
  timeoutMs: number = DEFAULT_API_TIMEOUT_MS,
  callerSignal?: AbortSignal
): Promise<Response> {
  if (callerSignal?.aborted) throw callerSignal.reason;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${urlWithoutQuery(url)}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
