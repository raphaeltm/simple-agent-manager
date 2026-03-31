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

import { persistError } from '../services/observability';

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

/** Serialize an Error (or unknown) into a structured log-safe object. */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const result: Record<string, unknown> = {
      error: err.message,
      errorName: err.name,
    };
    if (err.stack) {
      result.stack = err.stack;
    }
    if (err.cause) {
      result.cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
    }
    return result;
  }
  return { error: String(err) };
}

function emit(level: LogLevel, event: string, details: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
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
          persistError(db, {
            source: 'api',
            level: 'error',
            message: event,
            context: details ?? null,
          })
        );
      }
    },
  };
}
