import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { log, type Logger } from '../lib/logger';

export const REQUEST_LOG_EXCLUDED_PATHS = new Set([
  '/health',
  '/api/admin/observability/logs/ingest',
]);

/**
 * Emit one structured event per HTTP request. The tail ingest path is excluded
 * because logging it feeds the tail Worker back into the same endpoint.
 */
export function requestLoggingMiddleware(
  logger: Pick<Logger, 'info'> = log
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const start = Date.now();
    await next();

    const path = new URL(c.req.url).pathname;
    if (REQUEST_LOG_EXCLUDED_PATHS.has(path)) return;

    logger.info('http.request', {
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Date.now() - start,
    });
  };
}
