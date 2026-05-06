/**
 * Fetch wrapper with configurable timeout and retry.
 *
 * Cloudflare Workers support `AbortController`/`AbortSignal` for fetch cancellation.
 * This utility adds a timeout that aborts the request if it exceeds the specified duration,
 * and optional retry with bounded exponential backoff and jitter.
 */

const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

/** HTTP status codes considered transient and safe to retry. */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

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
 * Parse a retry-related env int or return the provided default.
 */
export function getRetryMaxAttempts(envValue: string | undefined, defaultVal: number = DEFAULT_RETRY_MAX_ATTEMPTS): number {
  if (!envValue) return defaultVal;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultVal;
  return parsed;
}

/**
 * Parse a retry delay env int or return the provided default.
 */
export function getRetryDelayMs(envValue: string | undefined, defaultVal: number): number {
  if (!envValue) return defaultVal;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultVal;
  return parsed;
}

/**
 * Compute bounded exponential backoff with jitter.
 *
 * delay = min(baseDelay * 2^attempt, maxDelay) + random jitter (0-25%)
 */
export function computeRetryDelayMs(
  attempt: number,
  baseDelayMs: number = DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_RETRY_MAX_DELAY_MS,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * Math.random() * 0.25;
  return Math.floor(capped + jitter);
}

/** Options for fetchWithTimeoutAndRetry. */
export interface FetchRetryOptions {
  /** Maximum number of retry attempts (0 = no retries). */
  maxAttempts?: number;
  /** Base delay for exponential backoff in ms. */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms. */
  maxDelayMs?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

/**
 * Determine whether an HTTP response or fetch error is retryable.
 */
function isRetryableResponse(response: Response): boolean {
  return RETRYABLE_STATUS_CODES.has(response.status);
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === 'AbortError' ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up')
  );
}

/**
 * Parse the Retry-After header value into a delay in milliseconds.
 * Supports both integer seconds and HTTP date formats.
 * Returns undefined if the header is missing or unparseable.
 */
function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  // Try HTTP date
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delayMs = date - Date.now();
    return delayMs > 0 ? delayMs : undefined;
  }
  return undefined;
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

/**
 * Fetch with timeout and automatic retry on transient failures.
 *
 * Retries on:
 *   - HTTP status codes: 408, 425, 429, 500, 502, 503, 504
 *   - Network/timeout errors (AbortError, fetch failed, ECONNREFUSED, etc.)
 *
 * Honors Retry-After headers when present.
 * Uses bounded exponential backoff with random jitter.
 */
export async function fetchWithTimeoutAndRetry(
  url: string | URL,
  init?: RequestInit,
  options?: FetchRetryOptions,
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;

  let lastError: Error | undefined;
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);

      if (!isRetryableResponse(response) || attempt >= maxAttempts) {
        return response;
      }

      // Retryable status — wait and try again
      lastResponse = response;
      const retryAfterMs = parseRetryAfter(response);
      const backoffMs = retryAfterMs ?? computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
      await sleep(backoffMs);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isRetryableError(err) || attempt >= maxAttempts) {
        throw lastError;
      }

      const backoffMs = computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs);
      await sleep(backoffMs);
    }
  }

  // Should not reach here, but if it does return last response or throw last error
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error(`fetchWithTimeoutAndRetry: exhausted ${maxAttempts} retries for ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
