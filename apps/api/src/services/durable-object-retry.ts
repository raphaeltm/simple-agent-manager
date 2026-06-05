import { parsePositiveInt } from '../lib/route-helpers';

export const DEFAULT_DO_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_DO_RETRY_BASE_DELAY_MS = 50;

const TRANSIENT_DURABLE_OBJECT_PATTERNS = [
  /durable object reset because its code was updated/i,
  /durable object reset/i,
  /durable object.*overload/i,
  /overload.*durable object/i,
];

export interface DurableObjectRetryEnv {
  DO_RETRY_MAX_ATTEMPTS?: string;
  DO_RETRY_BASE_DELAY_MS?: string;
}

export interface DurableObjectRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
}

export function isTransientDurableObjectError(err: unknown): boolean {
  const message = extractErrorMessage(err);
  if (!message) return false;
  return TRANSIENT_DURABLE_OBJECT_PATTERNS.some((pattern) => pattern.test(message));
}

export function getDurableObjectRetryConfig(env: DurableObjectRetryEnv): DurableObjectRetryConfig {
  return {
    maxAttempts: parsePositiveInt(env.DO_RETRY_MAX_ATTEMPTS, DEFAULT_DO_RETRY_MAX_ATTEMPTS),
    baseDelayMs: parsePositiveInt(env.DO_RETRY_BASE_DELAY_MS, DEFAULT_DO_RETRY_BASE_DELAY_MS),
  };
}

export function computeDurableObjectRetryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
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
