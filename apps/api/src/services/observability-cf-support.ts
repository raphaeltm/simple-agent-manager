/**
 * Observability support utilities: CF Observability API error type and
 * deterministic secret redaction for log/tool data before it can enter
 * model context.
 *
 * Split out of observability.ts per .claude/rules/18-file-size-limits.md —
 * pure extraction, no behavior change. Re-exported from observability.ts so
 * existing consumers keep their import path.
 */
import { REDACTED, redactSecretPatterns } from './secret-redaction';

/**
 * Remove potentially sensitive fields from CF API response details.
 */
const SENSITIVE_KEY_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|private[-_]?key|user[-_]?id|ip[-_]?address|user[-_]?agent)$/i;

function redactString(value: string): string {
  return redactSecretPatterns(value);
}

/** Deterministically redact nested tool/log data before it can enter model context. */
export function redactSensitiveData<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveData(item)) as T;
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitiveData(nested);
  }
  return result as T;
}

/**
 * Error class for CF API failures — surfaces a safe message.
 */
export class CfApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CfApiError';
  }
}
