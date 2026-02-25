import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { desc, eq, inArray } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Env } from '../index';
import { requireAuth, requireApproved, requireSuperadmin, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { queryErrors, getHealthSummary, getErrorTrends, queryCloudflareLogs, checkRateLimit, CfApiError } from '../services/observability';
import type { UserRole, UserStatus, PlatformErrorSource, PlatformErrorLevel } from '@simple-agent-manager/shared';

const adminRoutes = new Hono<{ Bindings: Env }>();

// All admin routes require auth + approval + superadmin
adminRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * GET /api/admin/users - List all users
 * Optional query param: ?status=pending|active|suspended
 */
adminRoutes.get('/users', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const statusFilter = c.req.query('status') as UserStatus | undefined;

  let query = db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
      role: schema.users.role,
      status: schema.users.status,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users);

  if (statusFilter && ['active', 'pending', 'suspended'].includes(statusFilter)) {
    query = query.where(eq(schema.users.status, statusFilter)) as typeof query;
  }

  const users = await query.all();

  return c.json({
    users: users.map((u) => ({
      ...u,
      createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt),
    })),
  });
});

/**
 * PATCH /api/admin/users/:userId - Approve or suspend a user
 * Body: { action: 'approve' | 'suspend' }
 */
adminRoutes.patch('/users/:userId', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const { userId } = c.req.param();
  const body = await c.req.json<{ action: string }>();

  if (!body.action || !['approve', 'suspend'].includes(body.action)) {
    throw errors.badRequest('action must be "approve" or "suspend"');
  }

  const target = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!target) {
    throw errors.notFound('User');
  }

  // Cannot modify other superadmins
  if (target.role === 'superadmin') {
    throw errors.forbidden('Cannot modify a superadmin account');
  }

  const newStatus: UserStatus = body.action === 'approve' ? 'active' : 'suspended';

  await db
    .update(schema.users)
    .set({
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));

  return c.json({ id: userId, status: newStatus });
});

/**
 * PATCH /api/admin/users/:userId/role - Change a user's role
 * Body: { role: 'admin' | 'user' }
 */
adminRoutes.patch('/users/:userId/role', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const { userId } = c.req.param();
  const currentUserId = getUserId(c);
  const body = await c.req.json<{ role: string }>();

  if (!body.role || !['admin', 'user'].includes(body.role)) {
    throw errors.badRequest('role must be "admin" or "user"');
  }

  if (userId === currentUserId) {
    throw errors.badRequest('Cannot change your own role');
  }

  const target = await db
    .select({ id: schema.users.id, role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();

  if (!target) {
    throw errors.notFound('User');
  }

  if (target.role === 'superadmin') {
    throw errors.forbidden('Cannot change a superadmin role');
  }

  const newRole = body.role as UserRole;

  await db
    .update(schema.users)
    .set({
      role: newRole,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, userId));

  return c.json({ id: userId, role: newRole });
});

/**
 * GET /api/admin/tasks/stuck - List tasks in transient states (queued, delegated, in_progress)
 *
 * Returns tasks that are currently being executed or may be stuck,
 * including their execution step for debugging.
 */
adminRoutes.get('/tasks/stuck', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  const stuckTasks = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      userId: schema.tasks.userId,
      title: schema.tasks.title,
      status: schema.tasks.status,
      executionStep: schema.tasks.executionStep,
      workspaceId: schema.tasks.workspaceId,
      autoProvisionedNodeId: schema.tasks.autoProvisionedNodeId,
      errorMessage: schema.tasks.errorMessage,
      startedAt: schema.tasks.startedAt,
      updatedAt: schema.tasks.updatedAt,
      createdAt: schema.tasks.createdAt,
    })
    .from(schema.tasks)
    .where(inArray(schema.tasks.status, ['queued', 'delegated', 'in_progress']))
    .all();

  const now = Date.now();
  const tasksWithAge = stuckTasks.map((t) => ({
    ...t,
    elapsedMs: now - new Date(t.updatedAt).getTime(),
    elapsedSeconds: Math.round((now - new Date(t.updatedAt).getTime()) / 1000),
  }));

  return c.json({ tasks: tasksWithAge });
});

/**
 * GET /api/admin/tasks/recent-failures - List recently failed tasks with error details
 *
 * Returns the most recent failed tasks for debugging delegation issues.
 */
adminRoutes.get('/tasks/recent-failures', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Number.parseInt(limitParam, 10) || 50, 200) : 50;

  const failures = await db
    .select({
      id: schema.tasks.id,
      projectId: schema.tasks.projectId,
      userId: schema.tasks.userId,
      title: schema.tasks.title,
      status: schema.tasks.status,
      executionStep: schema.tasks.executionStep,
      workspaceId: schema.tasks.workspaceId,
      autoProvisionedNodeId: schema.tasks.autoProvisionedNodeId,
      errorMessage: schema.tasks.errorMessage,
      startedAt: schema.tasks.startedAt,
      completedAt: schema.tasks.completedAt,
      updatedAt: schema.tasks.updatedAt,
      createdAt: schema.tasks.createdAt,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.status, 'failed'))
    .orderBy(desc(schema.tasks.completedAt))
    .limit(limit);

  return c.json({ tasks: failures });
});

// =============================================================================
// Admin Observability Routes (spec 023)
// =============================================================================

const VALID_ERROR_SOURCES = new Set<string>(['client', 'vm-agent', 'api']);
const VALID_ERROR_LEVELS = new Set<string>(['error', 'warn', 'info']);

/**
 * GET /api/admin/observability/errors - Query platform errors
 *
 * Query params: source, level, search, startTime, endTime, limit, cursor
 */
adminRoutes.get('/observability/errors', async (c) => {
  if (!c.env.OBSERVABILITY_DATABASE) {
    return c.json({ errors: [], cursor: null, hasMore: false, total: 0 });
  }

  const source = c.req.query('source');
  const level = c.req.query('level');
  const search = c.req.query('search');
  const startTime = c.req.query('startTime');
  const endTime = c.req.query('endTime');
  const limitParam = c.req.query('limit');
  const cursor = c.req.query('cursor');

  // Validate source
  if (source && source !== 'all' && !VALID_ERROR_SOURCES.has(source)) {
    throw errors.badRequest(`Invalid source: ${source}. Must be one of: client, vm-agent, api`);
  }

  // Validate level
  if (level && level !== 'all' && !VALID_ERROR_LEVELS.has(level)) {
    throw errors.badRequest(`Invalid level: ${level}. Must be one of: error, warn, info`);
  }

  // Validate limit
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (isNaN(limit) || limit < 1 || limit > 200)) {
    throw errors.badRequest('limit must be between 1 and 200');
  }

  const result = await queryErrors(c.env.OBSERVABILITY_DATABASE, {
    source: source && source !== 'all' ? source as PlatformErrorSource : undefined,
    level: level && level !== 'all' ? level as PlatformErrorLevel : undefined,
    search: search || undefined,
    startTime: startTime ? new Date(startTime).getTime() : undefined,
    endTime: endTime ? new Date(endTime).getTime() : undefined,
    limit,
    cursor: cursor || undefined,
  });

  return c.json(result);
});

/**
 * GET /api/admin/observability/health - Platform health summary
 */
adminRoutes.get('/observability/health', async (c) => {
  if (!c.env.OBSERVABILITY_DATABASE) {
    return c.json({
      activeNodes: 0,
      activeWorkspaces: 0,
      inProgressTasks: 0,
      errorCount24h: 0,
      timestamp: new Date().toISOString(),
    });
  }

  const result = await getHealthSummary(c.env.DATABASE, c.env.OBSERVABILITY_DATABASE);
  return c.json(result);
});

/**
 * GET /api/admin/observability/trends - Error trends over time
 *
 * Query params: range (1h|24h|7d|30d)
 */
adminRoutes.get('/observability/trends', async (c) => {
  if (!c.env.OBSERVABILITY_DATABASE) {
    return c.json({ range: '24h', interval: '1h', buckets: [] });
  }

  const range = c.req.query('range') || '24h';
  const validRanges = new Set(['1h', '24h', '7d', '30d']);
  if (!validRanges.has(range)) {
    throw errors.badRequest(`Invalid range: ${range}. Must be one of: 1h, 24h, 7d, 30d`);
  }

  const result = await getErrorTrends(c.env.OBSERVABILITY_DATABASE, range);
  return c.json(result);
});

/**
 * POST /api/admin/observability/logs/query - Query Cloudflare Workers Observability API
 *
 * Body: { timeRange: { start, end }, levels?, search?, limit?, cursor? }
 */
adminRoutes.post('/observability/logs/query', async (c) => {
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    throw errors.badRequest('Cloudflare API credentials not configured. Set CF_API_TOKEN and CF_ACCOUNT_ID.');
  }

  // Per-admin rate limiting
  const userId = getUserId(c);
  const rateLimit = checkRateLimit(userId, c.env);

  c.header('X-RateLimit-Remaining', String(rateLimit.remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(rateLimit.resetMs / 1000)));

  if (!rateLimit.allowed) {
    return c.json(
      { error: 'RATE_LIMITED', message: 'Too many log queries. Please wait before trying again.' },
      429
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    throw errors.badRequest('Invalid JSON body');
  }

  // Validate timeRange
  const timeRange = body.timeRange as { start?: string; end?: string } | undefined;
  if (!timeRange || !timeRange.start || !timeRange.end) {
    throw errors.badRequest('timeRange with start and end is required');
  }

  const startDate = new Date(timeRange.start);
  const endDate = new Date(timeRange.end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw errors.badRequest('timeRange start and end must be valid ISO 8601 dates');
  }

  // Validate levels
  const levels = body.levels as string[] | undefined;
  if (levels !== undefined) {
    if (!Array.isArray(levels)) {
      throw errors.badRequest('levels must be an array');
    }
    const validLogLevels = new Set(['error', 'warn', 'info', 'debug', 'log']);
    for (const level of levels) {
      if (!validLogLevels.has(level)) {
        throw errors.badRequest(`Invalid level: ${level}. Must be one of: error, warn, info, debug, log`);
      }
    }
  }

  // Validate limit
  const limit = body.limit as number | undefined;
  if (limit !== undefined && (typeof limit !== 'number' || limit < 1 || limit > 500)) {
    throw errors.badRequest('limit must be between 1 and 500');
  }

  try {
    const result = await queryCloudflareLogs({
      cfApiToken: c.env.CF_API_TOKEN,
      cfAccountId: c.env.CF_ACCOUNT_ID,
      timeRange: { start: timeRange.start, end: timeRange.end },
      levels: levels ?? undefined,
      search: (body.search as string) || undefined,
      limit,
      cursor: (body.cursor as string) || undefined,
    });

    return c.json(result);
  } catch (err) {
    if (err instanceof CfApiError) {
      return c.json({ error: 'CF_API_ERROR', message: err.message }, 502);
    }
    throw err;
  }
});

export { adminRoutes };
