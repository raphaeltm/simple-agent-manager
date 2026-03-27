import { Hono } from 'hono';
import type { Env } from '../index';
import { optionalAuth } from '../middleware/auth';
import { rateLimit, getRateLimit } from '../middleware/rate-limit';
import { errors } from '../middleware/error';
import { bucketUserAgent } from '../middleware/analytics';

/** Default max body size: 64 KB (configurable via MAX_ANALYTICS_INGEST_BODY_BYTES) */
const DEFAULT_MAX_BODY_BYTES = 65_536;

/** Default max batch size (configurable via MAX_ANALYTICS_INGEST_BATCH_SIZE) */
const DEFAULT_MAX_BATCH_SIZE = 25;

/** Max length for string fields in events */
const MAX_EVENT_NAME_LENGTH = 128;
const MAX_PAGE_LENGTH = 512;
const MAX_REFERRER_LENGTH = 1024;
const MAX_UTM_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 64;
const MAX_ENTITY_ID_LENGTH = 128;

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * Validate and sanitize a single client-side analytics event.
 * Returns null for malformed events (dropped silently).
 */
function validateEvent(raw: unknown): {
  event: string;
  page: string;
  referrer: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  sessionId: string;
  entityId: string;
  durationMs: number;
  visitorId: string;
} | null {
  if (!raw || typeof raw !== 'object') return null;

  const e = raw as Record<string, unknown>;

  // Event name is required
  if (typeof e.event !== 'string' || e.event.length === 0) return null;

  return {
    event: truncate(e.event, MAX_EVENT_NAME_LENGTH),
    page: typeof e.page === 'string' ? truncate(e.page, MAX_PAGE_LENGTH) : '',
    referrer: typeof e.referrer === 'string' ? truncate(e.referrer, MAX_REFERRER_LENGTH) : '',
    utmSource: typeof e.utmSource === 'string' ? truncate(e.utmSource, MAX_UTM_LENGTH) : '',
    utmMedium: typeof e.utmMedium === 'string' ? truncate(e.utmMedium, MAX_UTM_LENGTH) : '',
    utmCampaign: typeof e.utmCampaign === 'string' ? truncate(e.utmCampaign, MAX_UTM_LENGTH) : '',
    sessionId: typeof e.sessionId === 'string' ? truncate(e.sessionId, MAX_SESSION_ID_LENGTH) : '',
    entityId: typeof e.entityId === 'string' ? truncate(e.entityId, MAX_ENTITY_ID_LENGTH) : '',
    durationMs: typeof e.durationMs === 'number' && isFinite(e.durationMs) ? e.durationMs : 0,
    visitorId: typeof e.visitorId === 'string' ? truncate(e.visitorId, MAX_SESSION_ID_LENGTH) : '',
  };
}

const analyticsIngestRoutes = new Hono<{ Bindings: Env }>();

// Optional auth — include userId when available, allow unauthenticated
analyticsIngestRoutes.use('*', optionalAuth());

// Rate limit by IP (unauthenticated-safe)
analyticsIngestRoutes.use('*', async (c, next) => {
  const limiter = rateLimit({
    limit: getRateLimit(c.env, 'ANALYTICS_INGEST'),
    keyPrefix: 'analytics-ingest',
    useIp: true,
  });
  return limiter(c, next);
});

/**
 * POST /api/t
 *
 * Accepts a batch of client-side analytics events and writes each to
 * Analytics Engine. Returns 204.
 *
 * Body: { events: AnalyticsEvent[] }
 */
analyticsIngestRoutes.post('/', async (c) => {
  // Check if ingest is enabled
  if (c.env.ANALYTICS_INGEST_ENABLED === 'false') {
    return c.body(null, 204);
  }

  // Check if Analytics Engine binding exists (graceful degradation)
  if (!c.env.ANALYTICS) {
    return c.body(null, 204);
  }

  const maxBodyBytes = parseInt(
    c.env.MAX_ANALYTICS_INGEST_BODY_BYTES || String(DEFAULT_MAX_BODY_BYTES),
    10
  );
  const maxBatchSize = parseInt(
    c.env.MAX_ANALYTICS_INGEST_BATCH_SIZE || String(DEFAULT_MAX_BATCH_SIZE),
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
  if (!body || typeof body !== 'object' || !('events' in body)) {
    throw errors.badRequest('Body must contain an "events" array');
  }

  const { events } = body as { events: unknown };

  if (!Array.isArray(events)) {
    throw errors.badRequest('"events" must be an array');
  }

  if (events.length === 0) {
    return c.body(null, 204);
  }

  if (events.length > maxBatchSize) {
    throw errors.badRequest(`Batch too large (max ${maxBatchSize} events)`);
  }

  // Get optional auth context
  const auth = c.get('auth') as { user?: { id: string } } | undefined;
  const userId = auth?.user?.id ?? null;

  // Server-side enrichment
  const userAgentBucket = bucketUserAgent(c.req.header('user-agent'));
  const cfData = (c.req.raw as unknown as { cf?: { country?: string } }).cf;
  const country = cfData?.country ?? '';
  const ip = getClientIp(c);

  // Write each valid event to Analytics Engine (fire-and-forget)
  const writePromise = (async () => {
    try {
      for (const raw of events) {
        const validated = validateEvent(raw);
        if (!validated) continue;

        // Use authenticated userId, then client-provided visitorId, then IP hash
        const index = userId ?? (validated.visitorId || `anon-${ip}`);

        c.env.ANALYTICS.writeDataPoint({
          indexes: [index],
          blobs: [
            validated.event,       // blob1: event name
            '',                    // blob2: projectId (client events don't have this)
            validated.page,        // blob3: page/route
            validated.referrer,    // blob4: referrer
            validated.utmSource,   // blob5
            validated.utmMedium,   // blob6
            validated.utmCampaign, // blob7
            validated.sessionId,   // blob8: browser session ID
            userAgentBucket,       // blob9: server-derived UA bucket
            country,               // blob10: CF-provided country
            validated.entityId,    // blob11: entity ID
          ],
          doubles: [
            validated.durationMs,  // double1: duration on page
            0,                     // double2: status code (N/A for client events)
            0,                     // double3: reserved
          ],
        });
      }
    } catch (err) {
      console.warn('analytics-ingest: write failed', err instanceof Error ? err.message : String(err));
    }
  })();

  try { c.executionCtx.waitUntil(writePromise); } catch { /* no exec ctx in tests */ }

  return c.body(null, 204);
});

export { analyticsIngestRoutes };
