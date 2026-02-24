/**
 * Structured Logging Utility
 *
 * Provides consistent structured JSON logging for Cloudflare Workers.
 * All log entries are searchable in Cloudflare's log dashboard.
 *
 * Usage:
 *   import { log } from '../lib/logger';
 *   log.info('task_run.state_change', { taskId, fromStatus, toStatus });
 *   log.error('node_provisioning_failed', { nodeId, error: err.message });
 */

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
