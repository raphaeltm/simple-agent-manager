import type { Env } from '../env';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';

/**
 * Field-bounding helpers for observability error persistence: env-configurable
 * length limits, safe context serialization/parsing. Extracted from
 * observability.ts (rule 18 file-size split).
 */

export const DEFAULT_MAX_MESSAGE_LENGTH = 2048;
export const DEFAULT_MAX_STACK_LENGTH = 4096;
export const DEFAULT_MAX_USER_AGENT_LENGTH = 512;
export const DEFAULT_MAX_CONTEXT_LENGTH = 8192;

export type ObservabilityFieldLimitEnv = Pick<
  Env,
  | 'OBSERVABILITY_ERROR_MESSAGE_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_STACK_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_USER_AGENT_MAX_LENGTH'
  | 'OBSERVABILITY_ERROR_CONTEXT_MAX_LENGTH'
>;

export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

export function getFieldLimit(
  env: ObservabilityFieldLimitEnv,
  key: keyof ObservabilityFieldLimitEnv,
  fallback: number
): number {
  const parsed = Number.parseInt(env[key] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Serialize a context object with a byte bound. Oversized contexts are
 * replaced by a small valid-JSON sentinel (never sliced JSON, which would
 * break the reader's parse) that preserves diagnosability.
 */
export function serializeBoundedContext(
  context: Record<string, unknown>,
  maxLength: number
): string {
  const serialized = JSON.stringify(context);
  if (serialized.length <= maxLength) {
    return serialized;
  }
  return JSON.stringify({
    contextTruncated: true,
    originalLength: serialized.length,
    preview: serialized.slice(0, Math.max(0, Math.min(maxLength, 512))),
  });
}

/**
 * Parse a stored context JSON string, tolerating a single malformed row
 * (rule 50): a bad context degrades to null with a structured warn instead
 * of throwing the whole list read.
 */
export function safeParseContext(
  context: string | null,
  rowId: string
): Record<string, unknown> | null {
  if (!context) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(context);
  } catch (err) {
    log.warn('observability.context_parse_skipped', {
      rowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  // JSON.parse succeeding is not enough — the docstring promises malformed
  // context degrades to null, but a syntactically valid non-object JSON value
  // (a string, number, array, ...) previously slipped through as a blind
  // cast. maybeJsonRecord closes that gap.
  const record = maybeJsonRecord(parsed);
  if (record === null) {
    log.warn('observability.context_parse_skipped', {
      rowId,
      error: 'context JSON did not decode to an object',
    });
  }
  return record;
}
