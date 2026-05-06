import { ProviderError,type ProviderErrorReason, type ProviderIdempotencyRisk } from './types';

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_PROVIDER_RETRY_MAX_DELAY_MS = 10_000;
const DEFAULT_PROVIDER_RETRY_JITTER_RATIO = 0.25;

export interface ProviderRetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  retryableStatusCodes?: readonly number[];
  idempotencyRisk?: ProviderIdempotencyRisk;
}

interface NormalizedProviderError {
  message: string;
  reason: ProviderErrorReason;
  retryable: boolean;
  retryAfterMs?: number;
}

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

export function getRetryMaxAttempts(
  value: number | string | undefined,
  defaultAttempts: number = DEFAULT_PROVIDER_RETRY_MAX_ATTEMPTS,
): number {
  if (value === undefined || value === '') return defaultAttempts;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultAttempts;
  return Math.floor(parsed);
}

export function getRetryDelayMs(
  value: number | string | undefined,
  defaultMs: number,
): number {
  if (value === undefined || value === '') return defaultMs;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMs;
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
      const normalized = await normalizeHttpError(response);

      throw new ProviderError(
        providerName,
        response.status,
        `${providerName} API error (${response.status}): ${normalized.message}`,
        {
          retryable: normalized.retryable,
          reason: normalized.reason,
          retryAfterMs: normalized.retryAfterMs,
        },
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
        { cause: err, retryable: true, reason: 'timeout' },
      );
    }

    throw new ProviderError(
      providerName,
      undefined,
      `${providerName} API request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined, retryable: true, reason: 'network' },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function providerFetchWithRetry(
  providerName: string,
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  retryConfig: ProviderRetryConfig = {},
): Promise<Response> {
  const maxAttempts = getRetryMaxAttempts(retryConfig.maxAttempts);
  const baseDelayMs = getRetryDelayMs(retryConfig.baseDelayMs, DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS);
  const maxDelayMs = getRetryDelayMs(retryConfig.maxDelayMs, DEFAULT_PROVIDER_RETRY_MAX_DELAY_MS);
  const jitterRatio = retryConfig.jitterRatio ?? DEFAULT_PROVIDER_RETRY_JITTER_RATIO;

  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await providerFetch(providerName, url, init, timeoutMs);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      lastError = err;
      if (!shouldRetryProviderError(err, retryConfig) || attempt >= maxAttempts) {
        throw err;
      }

      const delayMs = err.retryAfterMs ?? computeRetryDelayMs(attempt, baseDelayMs, maxDelayMs, jitterRatio);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError ?? new ProviderError(providerName, undefined, `${providerName} API request failed without an error`);
}

export function shouldRetryProviderError(
  err: ProviderError,
  retryConfig: ProviderRetryConfig = {},
): boolean {
  if (retryConfig.retryableStatusCodes?.includes(err.statusCode ?? -1)) {
    return true;
  }
  return err.retryable;
}

export function computeRetryDelayMs(
  attempt: number,
  baseDelayMs: number = DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS,
  maxDelayMs: number = DEFAULT_PROVIDER_RETRY_MAX_DELAY_MS,
  jitterRatio: number = DEFAULT_PROVIDER_RETRY_JITTER_RATIO,
): number {
  const exponential = Math.min(baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), maxDelayMs);
  if (jitterRatio <= 0 || exponential <= 0) return exponential;
  const jitterRange = exponential * jitterRatio;
  const jitter = (Math.random() * jitterRange * 2) - jitterRange;
  return Math.max(0, Math.round(exponential + jitter));
}

async function normalizeHttpError(response: Response): Promise<NormalizedProviderError> {
  let errorMessage: string;
  try {
    const body = await response.text();
    try {
      const json = JSON.parse(body) as { error?: { message?: string }; message?: string };
      errorMessage = json.error?.message || json.message || body;
    } catch {
      errorMessage = body || `HTTP ${response.status}`;
    }
  } catch {
    errorMessage = `HTTP ${response.status}`;
  }

  return {
    message: errorMessage,
    reason: classifyHttpStatus(response.status),
    retryable: isRetryableHttpStatus(response.status),
    retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')),
  };
}

function classifyHttpStatus(status: number): ProviderErrorReason {
  if (status === 408) return 'timeout';
  if (status === 409 || status === 425) return 'conflict';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'provider_5xx';
  if (status >= 400) return 'validation';
  return 'unknown';
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}
