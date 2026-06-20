import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { log, serializeError } from '../lib/logger';
import { AppError } from '../middleware/error';
import { GcpApiError, sanitizeGcpError } from '../services/gcp-errors';
import type { ApiApp } from './types';

export function registerErrorHandling(app: ApiApp): void {
  // Global error handler — catches errors from all routes including subrouters.
  // Must use app.onError() instead of middleware try/catch because Hono's
  // app.route() subrouter errors don't propagate to parent middleware.
  app.onError((err, c) => {
    log.error('request_error', serializeError(err));

    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }

    // Defense-in-depth: sanitize GcpApiError if it escapes route-level catch blocks.
    if (err instanceof GcpApiError) {
      const safe = sanitizeGcpError(err, 'global-handler');
      return c.json({ error: 'GCP_UPSTREAM_ERROR', message: safe }, 502);
    }

    return c.json(
      {
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
      500,
    );
  });
}

export function registerNotFound(app: ApiApp): void {
  app.notFound((c) => {
    return c.json(
      {
        error: 'NOT_FOUND',
        message: 'Endpoint not found',
      },
      404,
    );
  });
}
