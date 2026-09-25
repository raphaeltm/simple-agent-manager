import { parsePositiveInt } from '../lib/route-helpers';

export const DEFAULT_DO_RETRY_MAX_ATTEMPTS = 8;
export const DEFAULT_DO_RETRY_BASE_DELAY_MS = 100;
export const DEFAULT_DO_RETRY_MAX_DELAY_MS = 250;
/**
 * Attempts for an idempotent call whose connection to the object was lost. A blip clears on the
 * next attempt; an outage (2026-09-24: 33 minutes, every call failing in ~190 ms) does not clear
 * within any retry budget, so spending the full `DO_RETRY_MAX_ATTEMPTS` there only multiplies
 * failing calls and delays the error.
 */
export const DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS = 3;

const TRANSIENT_DURABLE_OBJECT_PATTERNS = [
  /durable object reset because its code was updated/i,
  /durable object reset/i,
  /durable object'?s isolate exceeded its memory limit and was reset/i,
  /durable object storage operation exceeded timeout which caused object to be reset/i,
  /durable object.*overload/i,
  /overload.*durable object/i,
];

/**
 * Cloudflare's exact message when an object burns its CPU allowance and is reset. It is not in
 * `TRANSIENT_DURABLE_OBJECT_PATTERNS` — `/durable object reset/` needs that literal substring — and
 * it must stay out: the reset is usually collateral damage from ANOTHER request (on the SAM root
 * object, a 32.5 s `searchMessages`), but the request that caused it would reset the object again
 * if blindly retried, and mutations retry through that predicate.
 */
const CPU_LIMIT_RESET_PATTERN = /durable object exceeded its cpu time limit and was reset/i;

/**
 * The caller lost its connection to the object — during the 2026-09-24 outage every call failed
 * this way in ~190 ms. The call may or may not have executed, so only a caller whose operation
 * cannot duplicate an effect may repeat it.
 */
const CONNECTION_LOST_PATTERN = /^network connection lost\.?$/i;

const DURABLE_OBJECT_STORAGE_FULL_PATTERNS = [
  /\bSQLITE_FULL\b/i,
  /database or disk is full/i,
  /exceeded the maximum database size/i,
  /durable object.*storage.*full/i,
  /sqlite.*full/i,
];

export interface DurableObjectRetryEnv {
  DO_RETRY_MAX_ATTEMPTS?: string;
  DO_RETRY_BASE_DELAY_MS?: string;
  DO_RETRY_MAX_DELAY_MS?: string;
  DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS?: string;
}

export interface DurableObjectRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Never more than `maxAttempts`. */
  connectionLostMaxAttempts: number;
}

export function isTransientDurableObjectError(err: unknown): boolean {
  const message = extractErrorMessage(err);
  if (!message) return false;
  if (isDurableObjectStorageFullError(err)) return false;
  return TRANSIENT_DURABLE_OBJECT_PATTERNS.some((pattern) => pattern.test(message));
}

export function isDurableObjectStorageFullError(err: unknown): boolean {
  const message = extractErrorMessage(err);
  if (!message) return false;
  return DURABLE_OBJECT_STORAGE_FULL_PATTERNS.some((pattern) => pattern.test(message));
}

export function isDurableObjectCpuLimitResetError(err: unknown): boolean {
  return CPU_LIMIT_RESET_PATTERN.test(extractErrorMessage(err));
}

export function isDurableObjectConnectionLostError(err: unknown): boolean {
  return CONNECTION_LOST_PATTERN.test(extractErrorMessage(err).trim());
}

/**
 * Retry verdict for an operation its caller declares idempotent (a repeat cannot duplicate an
 * effect). Such a caller may also retry a CPU-limit reset or a lost connection; everything else
 * keeps `isTransientDurableObjectError`, which also governs mutation retries.
 */
export function isRetryableForIdempotentDurableObjectOperation(err: unknown): boolean {
  if (isDurableObjectStorageFullError(err)) return false;
  return (
    isTransientDurableObjectError(err) ||
    isDurableObjectCpuLimitResetError(err) ||
    isDurableObjectConnectionLostError(err)
  );
}

/**
 * Stable, message-free label for a Durable Object RPC failure, for telemetry that must group
 * failures without echoing error text. `null` means "not a platform-level object failure".
 */
export type DurableObjectErrorClass =
  'storage_full' | 'cpu_limit_reset' | 'connection_lost' | 'transient' | null;

export function classifyDurableObjectError(err: unknown): DurableObjectErrorClass {
  if (isDurableObjectStorageFullError(err)) return 'storage_full';
  if (isDurableObjectCpuLimitResetError(err)) return 'cpu_limit_reset';
  if (isDurableObjectConnectionLostError(err)) return 'connection_lost';
  if (isTransientDurableObjectError(err)) return 'transient';
  return null;
}

export function getDurableObjectRetryConfig(env: DurableObjectRetryEnv): DurableObjectRetryConfig {
  const maxAttempts = parsePositiveInt(env.DO_RETRY_MAX_ATTEMPTS, DEFAULT_DO_RETRY_MAX_ATTEMPTS);
  return {
    maxAttempts,
    baseDelayMs: parsePositiveInt(env.DO_RETRY_BASE_DELAY_MS, DEFAULT_DO_RETRY_BASE_DELAY_MS),
    maxDelayMs: parsePositiveInt(env.DO_RETRY_MAX_DELAY_MS, DEFAULT_DO_RETRY_MAX_DELAY_MS),
    connectionLostMaxAttempts: Math.min(
      maxAttempts,
      parsePositiveInt(
        env.DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS,
        DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS
      )
    ),
  };
}

export function computeDurableObjectRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)));
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
  }
  return '';
}
