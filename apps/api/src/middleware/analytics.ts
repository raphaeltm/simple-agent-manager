import type { MiddlewareHandler } from 'hono';
import type { Env } from '../index';
import { log } from '../lib/logger';

// ---------------------------------------------------------------------------
// Event name mapping: HTTP method + route pattern → human-readable event name
// ---------------------------------------------------------------------------

const EVENT_NAME_MAP: Record<string, string> = {
  // Auth
  'POST /auth/callback': 'login',
  'GET /auth/callback': 'login',
  'POST /auth/signup': 'signup',
  'GET /auth/session': 'session_check',

  // Projects
  'POST /api/projects': 'project_created',
  'DELETE /api/projects/:id': 'project_deleted',
  'GET /api/projects': 'projects_listed',
  'GET /api/projects/:id': 'project_viewed',
  'PATCH /api/projects/:id': 'project_updated',

  // Tasks
  'POST /api/projects/:projectId/tasks': 'task_submitted',
  'PATCH /api/projects/:projectId/tasks/:id': 'task_updated',
  'POST /api/projects/:projectId/tasks/:id/status': 'task_status_changed',
  'POST /api/projects/:projectId/tasks/:id/run': 'task_run_started',

  // Workspaces
  'POST /api/workspaces': 'workspace_created',
  'POST /api/workspaces/:id/start': 'workspace_started',
  'POST /api/workspaces/:id/stop': 'workspace_stopped',
  'DELETE /api/workspaces/:id': 'workspace_deleted',

  // Nodes
  'POST /api/nodes': 'node_created',
  'DELETE /api/nodes/:id': 'node_deleted',
  'GET /api/nodes': 'nodes_listed',

  // Credentials
  'POST /api/credentials': 'credential_saved',
  'DELETE /api/credentials/:id': 'credential_deleted',

  // Settings
  'PUT /api/agent-settings': 'settings_changed',

  // Chat / Sessions
  'POST /api/projects/:projectId/sessions': 'session_created',
  'GET /api/projects/:projectId/sessions': 'sessions_listed',

  // Dashboard
  'GET /api/dashboard': 'dashboard_viewed',
  'GET /api/dashboard/active-tasks': 'dashboard_active_tasks',

  // Admin
  'GET /api/admin/users': 'admin_users_viewed',
  'GET /api/admin/analytics/dau': 'admin_analytics_dau',
  'GET /api/admin/analytics/events': 'admin_analytics_events',
  'GET /api/admin/analytics/funnel': 'admin_analytics_funnel',
  'GET /api/admin/analytics/feature-adoption': 'admin_analytics_feature_adoption',
  'GET /api/admin/analytics/geo': 'admin_analytics_geo',
  'GET /api/admin/analytics/retention': 'admin_analytics_retention',

  // Notifications
  'GET /api/notifications': 'notifications_viewed',
};

/**
 * Derive event name from HTTP method + route pattern.
 * Falls back to "METHOD /route/pattern" for unmapped routes.
 */
export function getEventName(method: string, routePattern: string): string {
  const key = `${method} ${routePattern}`;
  return EVENT_NAME_MAP[key] ?? `${method} ${routePattern}`;
}

// ---------------------------------------------------------------------------
// Route patterns to skip (noisy internal endpoints)
// ---------------------------------------------------------------------------

const DEFAULT_SKIP_PATTERNS = [
  '/health',
  '/api/health',
  '/favicon.ico',
  '/robots.txt',
];

function shouldSkipRoute(path: string, extraSkipPatterns: string[]): boolean {
  const allPatterns = [...DEFAULT_SKIP_PATTERNS, ...extraSkipPatterns];
  return allPatterns.some((pattern) => path === pattern || path.startsWith(pattern + '/'));
}

// ---------------------------------------------------------------------------
// User-Agent bucketing
// ---------------------------------------------------------------------------

/**
 * Simplify user-agent string into a broad bucket.
 */
export function bucketUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'unknown';
  const lower = ua.toLowerCase();

  // Bot detection
  if (lower.includes('bot') || lower.includes('crawler') || lower.includes('spider')) {
    return 'bot';
  }

  // Mobile detection
  const isMobile = lower.includes('mobile') || lower.includes('android') || lower.includes('iphone');
  const platform = isMobile ? 'mobile' : 'desktop';

  // Browser detection
  if (lower.includes('firefox')) return `firefox-${platform}`;
  if (lower.includes('edg/') || lower.includes('edge')) return `edge-${platform}`;
  if (lower.includes('chrome') || lower.includes('chromium')) return `chrome-${platform}`;
  if (lower.includes('safari')) return `safari-${platform}`;
  if (lower.includes('curl')) return 'curl';

  return `other-${platform}`;
}

// ---------------------------------------------------------------------------
// Entity ID extraction from route path
// ---------------------------------------------------------------------------

/**
 * Extract the most specific entity ID from the URL path.
 * Returns the first UUID-like or short-ID segment after a known resource prefix.
 */
function extractEntityId(path: string): string {
  // Match patterns like /workspaces/:id, /nodes/:id, /projects/:id, /tasks/:id
  const patterns = [
    /\/tasks\/([^/]+)/,
    /\/workspaces\/([^/]+)/,
    /\/nodes\/([^/]+)/,
    /\/sessions\/([^/]+)/,
    /\/projects\/([^/]+)/,
  ];
  for (const re of patterns) {
    const match = path.match(re);
    if (match?.[1]) return match[1];
  }
  return '';
}

// ---------------------------------------------------------------------------
// Analytics middleware
// ---------------------------------------------------------------------------

/**
 * Hono middleware that writes one Analytics Engine data point per request.
 * Runs after the handler completes. Never blocks or fails the API response.
 *
 * Schema:
 *   index:   userId or "anonymous"
 *   blob1:   event name
 *   blob2:   projectId
 *   blob3:   route pattern
 *   blob4:   referrer
 *   blob5-7: utm_source, utm_medium, utm_campaign
 *   blob8:   request ID
 *   blob9:   user-agent bucket
 *   blob10:  country
 *   blob11:  entity ID from route
 *   double1: response time (ms)
 *   double2: HTTP status code
 *   double3: reserved (0)
 */
export function analyticsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const startTime = Date.now();

    // Always call next first — analytics must never block
    await next();

    // Check if analytics is enabled
    const enabled = c.env.ANALYTICS_ENABLED !== 'false';
    if (!enabled) return;

    // Check if the binding exists (graceful degradation for local dev)
    const analytics = c.env.ANALYTICS;
    if (!analytics) return;

    const path = new URL(c.req.url).pathname;

    // Skip CORS preflight requests — they are noise
    if (c.req.method === 'OPTIONS') return;

    // Parse extra skip patterns from env
    const extraSkip = c.env.ANALYTICS_SKIP_ROUTES
      ? c.env.ANALYTICS_SKIP_ROUTES.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    if (shouldSkipRoute(path, extraSkip)) return;

    // Fire-and-forget analytics write
    const writeAnalytics = async () => {
      try {
        const url = new URL(c.req.url);
        const method = c.req.method;
        const routePattern = c.req.routePath ?? path;
        const eventName = getEventName(method, routePattern);

        // Extract user ID from auth context (may not be set for unauthenticated routes)
        let userId = 'anonymous';
        try {
          const auth = c.get('auth');
          if (auth?.user?.id) userId = auth.user.id;
        } catch {
          // auth not set — keep anonymous
        }

        // Extract project ID from route params
        const projectId = (c.req.param as (key: string) => string | undefined)('projectId')
          ?? (c.req.param as (key: string) => string | undefined)('id')
          ?? '';

        // UTM params
        const utmSource = url.searchParams.get('utm_source') ?? '';
        const utmMedium = url.searchParams.get('utm_medium') ?? '';
        const utmCampaign = url.searchParams.get('utm_campaign') ?? '';

        // Request metadata
        const referrer = c.req.header('referer') ?? '';
        const requestId = c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? '';
        const userAgentBucket = bucketUserAgent(c.req.header('user-agent'));

        // Cloudflare-provided country
        const cfData = (c.req.raw as unknown as { cf?: { country?: string } }).cf;
        const country = cfData?.country ?? '';

        const entityId = extractEntityId(path);
        const responseTimeMs = Date.now() - startTime;
        const statusCode = c.res.status;

        await analytics.writeDataPoint({
          indexes: [userId],
          blobs: [
            eventName,       // blob1
            projectId,       // blob2
            routePattern,    // blob3
            referrer,        // blob4
            utmSource,       // blob5
            utmMedium,       // blob6
            utmCampaign,     // blob7
            requestId,       // blob8
            userAgentBucket, // blob9
            country,         // blob10
            entityId,        // blob11
          ],
          doubles: [
            responseTimeMs,  // double1
            statusCode,      // double2
            0,               // double3 (reserved)
          ],
        });
      } catch (err) {
        // Analytics failures must NEVER surface to the user
        log.warn('analytics.write_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    };

    // Use waitUntil so the response is not delayed
    c.executionCtx.waitUntil(writeAnalytics());
  };
}
