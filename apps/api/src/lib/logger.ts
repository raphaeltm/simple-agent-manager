// Moved to @simple-agent-manager/worker-core (worker modularization W0). This file re-exports the
// package logger so existing importers stay unchanged, and keeps the one worker-owned piece:
// `createInstrumentedLogger`, which plugs the observability D1 writer into the package's
// error-sink port.
import {
  createErrorSinkLogger,
  type LoggedErrorSink,
  type Logger,
} from '@simple-agent-manager/worker-core';

import type { ObservabilityFieldLimitEnv } from '../services/observability-fields';

export {
  createModuleLogger,
  log,
  type Logger,
  type LogLevel,
  serializeError,
} from '@simple-agent-manager/worker-core';

/**
 * Create a logger that also persists error-level entries to the observability D1 database.
 * Non-error entries are logged to console only. D1 writes are fire-and-forget via waitUntil.
 * If db or waitUntil is null, behaves identically to the standard `log` object.
 */
export function createInstrumentedLogger(
  db: D1Database | null,
  waitUntil: ((promise: Promise<unknown>) => void) | null,
  env?: ObservabilityFieldLimitEnv
): Logger {
  const sink: LoggedErrorSink | null = db
    ? (entry) =>
        import('../services/observability').then(({ persistError }) =>
          persistError(
            db,
            { source: 'api', level: 'error', message: entry.event, context: entry.context },
            env
          )
        )
    : null;
  return createErrorSinkLogger(sink, waitUntil);
}
