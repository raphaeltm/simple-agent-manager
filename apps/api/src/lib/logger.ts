/**
 * Structured Logging Utility
 *
 * Provides consistent structured JSON logging for Cloudflare Workers.
 * All log entries are searchable in Cloudflare's log dashboard.
 *
 * Each log entry is emitted as a single-line JSON object for Cloudflare
 * Workers dashboard filtering (e.g. filter by event name or level).
 *
 * Usage:
 *   import { log } from '../lib/logger';
 *   log.info('task_run.state_change', { taskId, fromStatus, toStatus });
 *   log.error('node_provisioning_failed', { nodeId, error: err.message });
 *
 * Module-scoped logger (prefixes all events with module name):
 *   import { createModuleLogger } from '../lib/logger';
 *   const log = createModuleLogger('transcribe');
 *   log.info('request_received');  // emits event: "transcribe.request_received"
 *
 * Error serialization:
 *   import { serializeError } from '../lib/logger';
 *   log.error('operation_failed', { ...serializeError(err), nodeId });
 *
 * Instrumented logger (persists error-level entries to observability D1):
 *   import { createInstrumentedLogger } from '../lib/logger';
 *   const ilog = createInstrumentedLogger(env.OBSERVABILITY_DATABASE, ctx.waitUntil.bind(ctx));
 *   ilog.error('api_failure', { path: '/api/test' }); // also writes to D1
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (event: string, details?: Record<string, unknown>) => void;
  info: (event: string, details?: Record<string, unknown>) => void;
  warn: (event: string, details?: Record<string, unknown>) => void;
  error: (event: string, details?: Record<string, unknown>) => void;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}


const REDACTED = '[REDACTED]';
const REDACTED_MESSAGE = '[REDACTED_ERROR_MESSAGE]';
const SENSITIVE_KEY_RE =
  /(?:^|[_-])(authorization|cookie|token|secret|password|passwd|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session|set[_-]?cookie)(?:$|[_-])/i;
const SENSITIVE_VALUE_RE =
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*|\b(?:sam_[A-Za-z0-9_]*|gh[oprsu]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gi;

function sanitizeString(value: string, redactWholeValue: boolean): string {
  if (redactWholeValue) return REDACTED;
  return value.replace(SENSITIVE_VALUE_RE, REDACTED);
}

function sanitizeLogValue(value: unknown, key?: string): unknown {
  const redactWholeValue = key ? SENSITIVE_KEY_RE.test(key) : false;

  if (typeof value === 'string') return sanitizeString(value, redactWholeValue);
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));

  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    sanitized[childKey] = sanitizeLogValue(childValue, childKey);
  }
  return sanitized;
}

function sanitizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    sanitized[key] = sanitizeLogValue(value, key);
  }
  return sanitized;
}

/** Serialize an Error (or unknown) into a structured log-safe object. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const result: Record<string, unknown> = {
      error: REDACTED_MESSAGE,
      errorName: err.name,
    };
    if (err.cause) {
      result.cause = err.cause instanceof Error ? REDACTED_MESSAGE : sanitizeString(String(err.cause), false);
    }
    return result;
  }
  return { error: sanitizeString(String(err), false) };
}

function emit(level: LogLevel, event: string, details: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogDetails(details),
  };

  const json = JSON.stringify(entry);
  switch (level) {
    case 'error':
      console.error(json);
      break;
    case 'warn':
      console.warn(json);
      break;
    case 'debug':
      console.debug(json);
      break;
    default:
      console.log(json);
  }
}

export const log: Logger = {
  debug: (event: string, details?: Record<string, unknown>) => emit('debug', event, details),
  info: (event: string, details?: Record<string, unknown>) => emit('info', event, details),
  warn: (event: string, details?: Record<string, unknown>) => emit('warn', event, details),
  error: (event: string, details?: Record<string, unknown>) => emit('error', event, details),
};

/** Create a logger that prefixes all event names with `module.` */
export function createModuleLogger(module: string): Logger {
  return {
    debug: (event: string, details?: Record<string, unknown>) => emit('debug', `${module}.${event}`, details),
    info: (event: string, details?: Record<string, unknown>) => emit('info', `${module}.${event}`, details),
    warn: (event: string, details?: Record<string, unknown>) => emit('warn', `${module}.${event}`, details),
    error: (event: string, details?: Record<string, unknown>) => emit('error', `${module}.${event}`, details),
  };
}

/**
 * Create a logger that also persists error-level entries to the observability D1 database.
 * Non-error entries are logged to console only. D1 writes are fire-and-forget via waitUntil.
 * If db or waitUntil is null, behaves identically to the standard `log` object.
 */
export function createInstrumentedLogger(
  db: D1Database | null,
  waitUntil: ((promise: Promise<unknown>) => void) | null
): Logger {
  return {
    debug: (event: string, details?: Record<string, unknown>) => emit('debug', event, details),
    info: (event: string, details?: Record<string, unknown>) => emit('info', event, details),
    warn: (event: string, details?: Record<string, unknown>) => emit('warn', event, details),
    error: (event: string, details?: Record<string, unknown>) => {
      emit('error', event, details);

      // Persist error-level entries to observability D1 (fire-and-forget)
      if (db && waitUntil) {
        waitUntil(
          import('../services/observability').then(({ persistError }) =>
            persistError(db, {
              source: 'api',
              level: 'error',
              message: event,
              context: details ? sanitizeLogDetails(details) : null,
            })
          )
        );
      }
    },
  };
}
