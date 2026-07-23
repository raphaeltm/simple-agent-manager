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
  maxErrorBodyChars: number = DEFAULT_MAX_PROVIDER_ERROR_BODY_CHARS
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
    if (err instanceof ProviderError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(
        providerName,
        undefined,
        `${providerName} API request timed out after ${timeoutMs}ms: ${url}`,
        { cause: err }
      );
    }

    throw new ProviderError(
      providerName,
      undefined,
      `${providerName} API request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err : undefined }
    );
  } finally {
    clearTimeout(timeoutId);
  }
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
