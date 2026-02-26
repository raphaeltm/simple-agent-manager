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
 * Instrumented logger (persists error-level entries to observability D1):
 *   import { createInstrumentedLogger } from '../lib/logger';
 *   const ilog = createInstrumentedLogger(env.OBSERVABILITY_DATABASE, ctx.waitUntil.bind(ctx));
 *   ilog.error('api_failure', { path: '/api/test' }); // also writes to D1
 */

import { persistError } from '../services/observability';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, event: string, details: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  };

  switch (level) {
    case 'error':
      console.error(JSON.stringify(entry));
      break;
    case 'warn':
      console.warn(JSON.stringify(entry));
      break;
    case 'debug':
      console.debug(JSON.stringify(entry));
      break;
    default:
      console.log(JSON.stringify(entry));
  }
}

export const log = {
  debug: (event: string, details?: Record<string, unknown>) => emit('debug', event, details),
  info: (event: string, details?: Record<string, unknown>) => emit('info', event, details),
  warn: (event: string, details?: Record<string, unknown>) => emit('warn', event, details),
  error: (event: string, details?: Record<string, unknown>) => emit('error', event, details),
};

/**
 * Create a logger that also persists error-level entries to the observability D1 database.
 * Non-error entries are logged to console only. D1 writes are fire-and-forget via waitUntil.
 * If db or waitUntil is null, behaves identically to the standard `log` object.
 */
export function createInstrumentedLogger(
  db: D1Database | null,
  waitUntil: ((promise: Promise<unknown>) => void) | null
) {
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
