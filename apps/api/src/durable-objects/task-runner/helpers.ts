/**
 * Pure helper functions for the TaskRunner DO.
 *
 * Extracted into a separate module so they can be tested without
 * importing the DO class (which depends on `cloudflare:workers`).
 */

export function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function computeBackoffMs(
  retryCount: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  // Exponential backoff: base * 2^retry, capped at max
  const delay = baseDelayMs * Math.pow(2, retryCount);
  return Math.min(delay, maxDelayMs);
}

/**
 * Determines whether an error is transient (retryable) or permanent.
 * Transient: network errors, timeouts, 5xx responses, rate limits
 * Permanent: 4xx errors (except 429), validation failures, NOT_FOUND
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Check explicit permanent flag set via Object.assign(new Error(...), { permanent: true })
  if ((err as Error & { permanent?: boolean }).permanent === true) {
    return false;
  }

  const msg = err.message.toLowerCase();

  // Network / timeout errors — always transient
  if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound')) {
    return true;
  }

  // HTTP status based errors
  if (msg.includes('429') || msg.includes('rate limit')) return true;
  if (msg.match(/\b5\d{2}\b/)) return true; // 5xx

  // Explicit permanent errors
  if (msg.includes('not found') || msg.includes('not_found') || msg.includes('limit_exceeded') || msg.includes('invalid') || msg.includes('forbidden') || msg.includes('unauthorized')) {
    return false;
  }

  // Default to transient for unknown errors
  return true;
}
