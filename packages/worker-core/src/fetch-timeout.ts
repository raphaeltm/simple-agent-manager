import { deadlineResponse } from './fetch-timeout-body';

/**
 * Fetch wrapper with configurable timeout.
 *
 * Cloudflare Workers support `AbortController`/`AbortSignal` for fetch cancellation.
 * This utility adds a timeout that aborts the request if it exceeds the specified duration.
 */

export class IoTimeoutError extends Error {
  override name = 'TimeoutError';
}

const DEFAULT_API_TIMEOUT_MS = 30_000;

/**
 * Parse a timeout from env or return the default.
 */
export function getTimeoutMs(
  envValue: string | undefined,
  defaultMs: number = DEFAULT_API_TIMEOUT_MS
): number {
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
  callerSignal ??= init?.signal ?? undefined;
  if (callerSignal?.aborted) throw callerSignal.reason;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const timeoutError = new IoTimeoutError(
    `Request timed out after ${timeoutMs}ms: ${urlWithoutQuery(url)}`
  );
  const timeoutId = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const cleanup = () => {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };

  try {
    const response = await fetch(url.toString(), {
      ...init,
      signal: controller.signal,
    });
    return deadlineResponse(response, controller.signal, cleanup);
  } catch (err) {
    cleanup();
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (controller.signal.aborted) throw controller.signal.reason;
    throw err;
  }
}

/** Bound an entire I/O operation, including APIs that cannot themselves be canceled. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal
): Promise<T> {
  if (callerSignal?.aborted) throw callerSignal.reason;
  const controller = new AbortController();
  const onAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new IoTimeoutError(`Operation timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    if (callerSignal?.aborted) onAbort();
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
