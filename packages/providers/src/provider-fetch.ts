import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import { expectObject } from './validation-core';

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PROVIDER_ERROR_BODY_CHARS = 4_096;

/**
 * Parse a timeout from an env value string or return the default.
 */
export function getTimeoutMs(
  envValue: string | undefined,
  defaultMs: number = DEFAULT_PROVIDER_TIMEOUT_MS
): number {
  return parsePositiveInteger(envValue, defaultMs);
}

/**
 * Parse the maximum provider error-body characters from an env value string or return the default.
 */
export function getMaxProviderErrorBodyChars(
  envValue: string | undefined,
  defaultChars: number = DEFAULT_MAX_PROVIDER_ERROR_BODY_CHARS
): number {
  return parsePositiveInteger(envValue, defaultChars);
}

/**
 * Fetch wrapper for provider API calls.
 * Adds configurable timeout via AbortController and wraps errors into ProviderError.
 *
 * @param providerName - Provider identifier for error context
 * @param url - The URL to fetch
 * @param init - Standard RequestInit options
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 * @param maxErrorBodyChars - Maximum provider error-body detail to include in the error message
 * @returns The fetch Response
 * @throws ProviderError on HTTP errors, timeouts, and network failures
 */
export async function providerFetch(
  providerName: string,
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
  maxErrorBodyChars: number = DEFAULT_MAX_PROVIDER_ERROR_BODY_CHARS,
  context?: ProviderRequestContext
): Promise<Response> {
  const callerSignals = uniqueSignals(init?.signal, context?.signal);
  for (const signal of callerSignals) {
    if (signal.aborted) throw signal.reason;
  }

  const controller = new AbortController();
  let abortSource: { type: 'caller'; signal: AbortSignal } | { type: 'timeout' } | undefined;
  const callerListeners = callerSignals.map((signal) => {
    const listener = () => {
      if (abortSource) return;
      abortSource = { type: 'caller', signal };
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
    return { signal, listener };
  });
  const timeoutId = setTimeout(() => {
    if (abortSource) return;
    abortSource = { type: 'timeout' };
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorMessage: string;
      let providerCode: string | undefined;
      try {
        const body = await response.text();
        // Try parsing as JSON for structured error messages
        try {
          const json = expectObject(JSON.parse(body), 'provider', 'error_response');
          // `error` may be a nested object ({code,message}, Hetzner/GCP-style) OR a
          // plain string (Vultr: {"error":"...","status":n}). Handle both without
          // throwing — a thrown expectObject would drop us to the raw-body fallback,
          // dumping the whole JSON blob into the message.
          const rawError = json.error;
          const error =
            rawError && typeof rawError === 'object' && !Array.isArray(rawError)
              ? (rawError as Record<string, unknown>)
              : null;
          const stringError = typeof rawError === 'string' ? rawError : undefined;
          // Extract structured error code from the provider response
          providerCode =
            (typeof error?.code === 'string' ? error.code : undefined) ||
            (typeof json.type === 'string' ? json.type : undefined) ||
            (typeof json.code === 'string' ? json.code : undefined) ||
            (typeof error?.status === 'string' ? error.status : undefined) ||
            (typeof json.status === 'string' && isNaN(Number(json.status))
              ? json.status
              : undefined) ||
            undefined;
          errorMessage = boundProviderErrorDetail(
            maxErrorBodyChars,
            (typeof error?.message === 'string' ? error.message : undefined) ||
              stringError ||
              (typeof json.message === 'string' ? json.message : undefined) ||
              body
          );
        } catch {
          errorMessage = body
            ? boundProviderErrorDetail(maxErrorBodyChars, body)
            : `HTTP ${response.status}`;
        }
      } catch {
        errorMessage = `HTTP ${response.status}`;
      }

      throw new ProviderError(
        providerName,
        response.status,
        `${providerName} API error (${response.status}): ${errorMessage}`,
        { providerCode }
      );
    }

    return response;
  } catch (err) {
    if (abortSource?.type === 'caller') throw abortSource.signal.reason;

    if (abortSource?.type === 'timeout') {
      throw new ProviderError(
        providerName,
        undefined,
        `${providerName} API request timed out after ${timeoutMs}ms: ${url}`,
        { cause: err instanceof Error ? err : undefined }
      );
    }

    if (err instanceof ProviderError) throw err;

    throw new ProviderError(
      providerName,
      undefined,
      `${providerName} API request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined }
    );
  } finally {
    clearTimeout(timeoutId);
    for (const { signal, listener } of callerListeners) {
      signal.removeEventListener('abort', listener);
    }
  }
}

/** Throw the caller's exact abort reason before starting more provider work. */
export function throwIfProviderRequestAborted(context?: ProviderRequestContext): void {
  if (context?.signal?.aborted) throw context.signal.reason;
}

/** True only when `error` is the exact reason that cancelled this request. */
export function isProviderRequestAborted(
  error: unknown,
  context?: ProviderRequestContext
): boolean {
  return context?.signal?.aborted === true && Object.is(error, context.signal.reason);
}

/** Preserve caller cancellation identity before provider-specific error handling. */
export function rethrowIfProviderRequestAborted(
  error: unknown,
  context?: ProviderRequestContext
): void {
  if (isProviderRequestAborted(error, context)) throw error;
}

/** Wait between retries or polls while remaining promptly caller-cancellable. */
export function providerDelay(ms: number, context?: ProviderRequestContext): Promise<void> {
  throwIfProviderRequestAborted(context);
  const signal = context?.signal;
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const timeoutId = setTimeout(() => finish(resolve), ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function parsePositiveInteger(envValue: string | undefined, defaultValue: number): number {
  if (!envValue) return defaultValue;
  const parsed = Number.parseInt(envValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

function boundProviderErrorDetail(maxChars: number, detail: string): string {
  const effectiveMaxChars = Math.max(1, Math.floor(maxChars));
  if (detail.length <= effectiveMaxChars) return detail;
  return `${detail.slice(0, effectiveMaxChars)}… [truncated ${detail.length - effectiveMaxChars} chars]`;
}

function uniqueSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal[] {
  return [
    ...new Set(
      signals.filter((signal): signal is AbortSignal => signal !== undefined && signal !== null)
    ),
  ];
}
