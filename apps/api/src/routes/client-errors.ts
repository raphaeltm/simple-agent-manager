import { Hono } from 'hono';
import type { Env } from '../index';
import { optionalAuth } from '../middleware/auth';
import { rateLimit, getRateLimit } from '../middleware/rate-limit';
import { errors } from '../middleware/error';
import { persistErrorBatch, type PersistErrorInput } from '../services/observability';

/** Default max body size: 64 KB (configurable via MAX_CLIENT_ERROR_BODY_BYTES) */
const DEFAULT_MAX_BODY_BYTES = 65_536;

/** Default max batch size (configurable via MAX_CLIENT_ERROR_BATCH_SIZE) */
const DEFAULT_MAX_BATCH_SIZE = 25;

/** Truncation limits for string fields */
const MAX_MESSAGE_LENGTH = 2048;
const MAX_SOURCE_LENGTH = 256;
const MAX_STACK_LENGTH = 4096;

const VALID_LEVELS = new Set(['error', 'warn', 'info']);

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}

const clientErrorsRoutes = new Hono<{ Bindings: Env }>();

// Optional auth — include userId when available, allow unauthenticated
clientErrorsRoutes.use('*', optionalAuth());

// Rate limit by IP (unauthenticated-safe)
clientErrorsRoutes.use('*', async (c, next) => {
  const limiter = rateLimit({
    limit: getRateLimit(c.env, 'CLIENT_ERRORS'),
    keyPrefix: 'client-errors',
    useIp: true,
  });
  return limiter(c, next);
});

/**
 * POST /api/client-errors
 *
 * Accepts a batch of client-side error entries and logs each to
 * Workers observability via console.error(). Returns 204.
 *
 * Body: { errors: ClientErrorEntry[] }
 */
clientErrorsRoutes.post('/', async (c) => {
  const maxBodyBytes = parseInt(
    c.env.MAX_CLIENT_ERROR_BODY_BYTES || String(DEFAULT_MAX_BODY_BYTES),
    10
  );
  const maxBatchSize = parseInt(
    c.env.MAX_CLIENT_ERROR_BATCH_SIZE || String(DEFAULT_MAX_BATCH_SIZE),
    10
  );

  // Check Content-Length before reading body
  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
  if (contentLength > maxBodyBytes) {
    throw errors.badRequest(`Request body too large (max ${maxBodyBytes} bytes)`);
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.badRequest('Invalid JSON body');
  }

  // Validate structure
  if (!body || typeof body !== 'object' || !('errors' in body)) {
    throw errors.badRequest('Body must contain an "errors" array');
  }

  const { errors: entries } = body as { errors: unknown };

  if (!Array.isArray(entries)) {
    throw errors.badRequest('"errors" must be an array');
  }

  if (entries.length === 0) {
    return c.body(null, 204);
  }

  if (entries.length > maxBatchSize) {
    throw errors.badRequest(`Batch too large (max ${maxBatchSize} entries)`);
  }

  // Get optional auth context
  const auth = c.get('auth') as { user?: { id: string } } | undefined;
  const userId = auth?.user?.id ?? null;
  const ip = getClientIp(c);

  // Collect validated entries for D1 persistence
  const persistInputs: PersistErrorInput[] = [];

  // Log each entry individually for CF observability searchability
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const e = entry as Record<string, unknown>;

    // Validate required fields
    const message = typeof e.message === 'string' ? e.message : null;
    const source = typeof e.source === 'string' ? e.source : null;

    if (!message || !source) continue; // Skip malformed entries

    const level = typeof e.level === 'string' && VALID_LEVELS.has(e.level)
      ? e.level
      : 'error';

    console.error('[client-error]', {
      level,
      message: truncate(message, MAX_MESSAGE_LENGTH),
      source: truncate(source, MAX_SOURCE_LENGTH),
      stack: typeof e.stack === 'string' ? truncate(e.stack, MAX_STACK_LENGTH) : null,
      pageUrl: typeof e.url === 'string' ? truncate(e.url, MAX_MESSAGE_LENGTH) : null,
      userAgent: typeof e.userAgent === 'string' ? truncate(e.userAgent, 512) : null,
      clientTimestamp: typeof e.timestamp === 'string' ? e.timestamp : null,
      context: e.context && typeof e.context === 'object' ? e.context : null,
      userId,
      ip,
    });

    // Collect for D1 persistence
    persistInputs.push({
      source: 'client',
      level: level as PersistErrorInput['level'],
      message,
      stack: typeof e.stack === 'string' ? e.stack : null,
      context: e.context && typeof e.context === 'object' ? e.context as Record<string, unknown> : null,
      userId,
      ipAddress: ip,
      userAgent: typeof e.userAgent === 'string' ? e.userAgent : null,
      timestamp: typeof e.timestamp === 'string' ? new Date(e.timestamp).getTime() || Date.now() : Date.now(),
    });
  }

  // Persist to observability D1 (fire-and-forget, fail-silent)
  if (persistInputs.length > 0 && c.env.OBSERVABILITY_DATABASE) {
    const promise = persistErrorBatch(c.env.OBSERVABILITY_DATABASE, persistInputs, c.env)
      .catch(() => {}); // Never let D1 writes impact the response
    try { c.executionCtx.waitUntil(promise); } catch { /* no exec ctx (e.g. tests) */ }
  }

  return c.body(null, 204);
});

export { clientErrorsRoutes };
