import type { UserRole, UserStatus } from '@simple-agent-manager/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { ProjectData as ProjectDataDO } from '../durable-objects/project-data';
import type { Env } from '../env';
import { getUserId, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import { getTaskReconciliationDiagnostics } from '../scheduled/stuck-tasks';
import {
  AdminUserActionSchema,
  AdminUserRoleSchema,
  jsonValidator,
  parseOptionalBody,
  ProjectDataStorageEmergencyPurgeSchema,
  UpdateSignupApprovalConfigSchema,
} from '../schemas';
import { getRuntimeLimits } from '../services/limits';
import {
  measureProjectDataStorage,
  runProjectDataStorageEmergencyPurge,
} from '../services/project-data';
import { getSignupApprovalConfig, setSignupApprovalConfig } from '../services/signup-approval';
import { getVmAdmissionDiagnostics } from '../services/vm-admission-control';
import { adminObservabilityRoutes } from './admin/observability';

const adminRoutes = new Hono<{ Bindings: Env }>();
const PROJECT_DATA_STORAGE_STATUSES = new Set([
  'ok',
  'notice',
  'warning',
  'critical',
  'degraded',
]);
const DEFAULT_STORAGE_TELEMETRY_LIMIT = 50;
const MAX_STORAGE_TELEMETRY_LIMIT = 200;

// All admin routes require auth + approval + superadmin
adminRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());

/**
 * GET /api/admin/signup-approval - Read runtime signup approval config
 */
adminRoutes.get('/signup-approval', async (c) => {
  const config = await getSignupApprovalConfig(c.env);
  return c.json({ config });
});

/**
 * PUT /api/admin/signup-approval - Update runtime signup approval config
 * Body: { requireApproval: boolean }
 */
adminRoutes.put('/signup-approval', jsonValidator(UpdateSignupApprovalConfigSchema), async (c) => {
  const body = c.req.valid('json');
  const config = await setSignupApprovalConfig(c.env, {
    requireApproval: body.requireApproval,
    updatedBy: getUserId(c),
  });
  return c.json({ config });
});

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
adminRoutes.patch('/users/:userId', jsonValidator(AdminUserActionSchema), async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const { userId } = c.req.param();
  const currentUserId = getUserId(c);
  const body = c.req.valid('json');

  // Prevent self-suspension (mirrors self-role-change protection)
  if (userId === currentUserId) {
    throw errors.badRequest('Cannot modify your own account');
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
adminRoutes.patch('/users/:userId/role', jsonValidator(AdminUserRoleSchema), async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const { userId } = c.req.param();
  const currentUserId = getUserId(c);
  const body = c.req.valid('json');

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
 * GET /api/admin/tasks/:taskId/reconciliation-diagnostics - Explain the
 * read-only evidence and decision used by scheduled task reconciliation.
 */
adminRoutes.get('/tasks/:taskId/reconciliation-diagnostics', async (c) => {
  const { taskId } = c.req.param();
  const diagnostics = await getTaskReconciliationDiagnostics(c.env, taskId);

  if (!diagnostics) throw errors.notFound('Task');
  return c.json({ diagnostics });
});

/**
 * GET /api/admin/vm-admissions - Bounded list of VM admission records.
 */
adminRoutes.get('/vm-admissions', async (c) => {
  const limits = getRuntimeLimits(c.env);
  const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(1, limitParam), limits.taskListMaxPageSize)
    : limits.taskListDefaultPageSize;
  const state = c.req.query('state')?.trim();
  const binds: unknown[] = [];
  const where = state ? 'WHERE state = ?' : '';
  if (state) binds.push(state);
  binds.push(limit);

  const rows = await c.env.DATABASE.prepare(
    `
      SELECT task_id, project_id, user_id, provider, credential_domain_key,
        provider_domain_key, scope_key, requested_vm_size, requested_vm_location,
        state, reason, selected_node_id, inflight_node_id, fencing_token,
        attempt_count, next_retry_at, wait_deadline_at, provider_category,
        provider_code, provider_status_code, provider_message, enqueued_at,
        claimed_at, last_evaluated_at, completed_at, updated_at
      FROM vm_task_admissions
      ${where}
      ORDER BY updated_at DESC
      LIMIT ?
    `
  )
    .bind(...binds)
    .all<Record<string, unknown>>();

  return c.json({ admissions: rows.results ?? [], limit });
});

/**
 * GET /api/admin/vm-admissions/:taskId - Full admission/lease/capacity diagnostics.
 */
adminRoutes.get('/vm-admissions/:taskId', async (c) => {
  const { taskId } = c.req.param();
  const diagnostics = await getVmAdmissionDiagnostics(c.env, taskId);
  if (!diagnostics.admission) throw errors.notFound('VM admission');
  return c.json({ diagnostics });
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

/**
 * GET /api/admin/project-data/storage - Read latest ProjectData storage telemetry.
 *
 * Bounded D1 query only. Force-measure a specific project through the POST
 * endpoint when the row is missing or stale.
 */
adminRoutes.get('/project-data/storage', async (c) => {
  const status = c.req.query('status')?.trim();
  if (status && !PROJECT_DATA_STORAGE_STATUSES.has(status)) {
    throw errors.badRequest('status must be ok, notice, warning, critical, or degraded');
  }

  const projectId = c.req.query('projectId')?.trim();
  const limitParam = c.req.query('limit');
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : DEFAULT_STORAGE_TELEMETRY_LIMIT;
  if (
    !Number.isSafeInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > MAX_STORAGE_TELEMETRY_LIMIT
  ) {
    throw errors.badRequest(`limit must be between 1 and ${MAX_STORAGE_TELEMETRY_LIMIT}`);
  }

  const filters: string[] = [];
  const params: Array<string | number> = [];
  if (status) {
    filters.push('t.status = ?');
    params.push(status);
  }
  if (projectId) {
    filters.push('t.project_id = ?');
    params.push(projectId);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await c.env.DATABASE.prepare(
    `SELECT
       t.project_id,
       p.name AS project_name,
       p.repository AS repository,
       t.measured_at,
       t.database_size_bytes,
       t.limit_bytes,
       t.usage_ratio,
       t.status,
       t.last_alarm_at,
       t.last_alert_at,
       t.last_alert_status,
       t.last_purge_at,
       t.last_purge_reason,
       t.last_purge_rows,
       t.last_purge_database_size_bytes,
       t.last_error,
       t.updated_at
     FROM project_data_storage_telemetry t
     LEFT JOIN projects p ON p.id = t.project_id
     ${whereClause}
     ORDER BY t.usage_ratio DESC, t.measured_at DESC
     LIMIT ?`
  )
    .bind(...params, parsedLimit)
    .all();

  return c.json({ telemetry: result.results ?? [] });
});

/**
 * POST /api/admin/project-data/storage/:projectId/measure - Force a measurement.
 */
adminRoutes.post('/project-data/storage/:projectId/measure', async (c) => {
  const { projectId } = c.req.param();
  if (!projectId) throw errors.badRequest('projectId is required');
  const telemetry = await measureProjectDataStorage(c.env, projectId);
  return c.json({ telemetry });
});

/**
 * POST /api/admin/project-data/storage/:projectId/emergency-purge
 *
 * Explicit superadmin-only recovery path. Deletes only bounded batches of
 * oldest ProjectData event-log rows (activity_events and acp_session_events).
 */
adminRoutes.post('/project-data/storage/:projectId/emergency-purge', async (c) => {
  const { projectId } = c.req.param();
  if (!projectId) throw errors.badRequest('projectId is required');
  const body = await parseOptionalBody(c.req.raw, ProjectDataStorageEmergencyPurgeSchema, {});
  const result = await runProjectDataStorageEmergencyPurge(c.env, projectId, body);
  return c.json({ result });
});


// Admin observability routes (spec 023) — extracted sub-router (rule 18 file-size split)
adminRoutes.route('/observability', adminObservabilityRoutes);

/**
 * GET /api/admin/health/details - Detailed health info (superadmin only)
 * Returns binding availability, runtime limits, and missing bindings.
 */
adminRoutes.get('/health/details', (c) => {
  const limits = getRuntimeLimits(c.env);

  const bindings: Record<string, boolean> = {
    DATABASE: !!c.env.DATABASE,
    KV: !!c.env.KV,
    PROJECT_DATA: !!c.env.PROJECT_DATA,
    NODE_LIFECYCLE: !!c.env.NODE_LIFECYCLE,
    TASK_RUNNER: !!c.env.TASK_RUNNER,
    ADMIN_LOGS: !!c.env.ADMIN_LOGS,
    NOTIFICATION: !!c.env.NOTIFICATION,
  };

  const missingBindings = Object.entries(bindings)
    .filter(([, available]) => !available)
    .map(([name]) => name);

  return c.json({
    status: missingBindings.length > 0 ? 'degraded' : 'healthy',
    version: c.env.VERSION,
    timestamp: new Date().toISOString(),
    limits,
    bindings,
    ...(missingBindings.length > 0 && { missingBindings }),
  });
});

/**
 * POST /api/admin/backfill-session-summaries
 * One-time backfill: fans out to all project DOs to read sessions,
 * then bulk-inserts into D1 session_summaries.
 */
adminRoutes.post('/backfill-session-summaries', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });

  // Get all projects with their owners
  const projects = await db
    .select({ id: schema.projects.id, userId: schema.projects.userId })
    .from(schema.projects)
    .all();

  let totalSynced = 0;
  const projectErrors: Array<{ projectId: string; error: string }> = [];

  for (const project of projects) {
    try {
      const doId = c.env.PROJECT_DATA.idFromName(project.id);
      const stub = c.env.PROJECT_DATA.get(doId) as DurableObjectStub<ProjectDataDO>;

      // List all sessions from the DO (up to 1000)
      const result = (await stub.listSessions(null, 1000, 0)) as {
        sessions: Record<string, unknown>[];
        total: number;
      };

      if (result.sessions.length === 0) continue;

      // Batch upsert to D1
      const stmts = result.sessions.map((session: Record<string, unknown>) =>
        c.env.DATABASE.prepare(
          `INSERT INTO session_summaries
             (id, project_id, user_id, status, topic, task_id, workspace_id,
              message_count, started_at, last_message_at, agent_completed_at, ended_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             topic = excluded.topic,
             task_id = excluded.task_id,
             workspace_id = excluded.workspace_id,
             message_count = excluded.message_count,
             last_message_at = excluded.last_message_at,
             agent_completed_at = excluded.agent_completed_at,
             ended_at = excluded.ended_at,
             updated_at = excluded.updated_at`
        ).bind(
          session.id as string,
          project.id,
          project.userId,
          session.status as string,
          (session.topic as string | null) ?? null,
          (session.taskId as string | null) ?? null,
          (session.workspaceId as string | null) ?? null,
          (session.messageCount as number) ?? 0,
          (session.startedAt as number) ?? Date.now(),
          (session.lastMessageAt as number | null) ?? null,
          (session.agentCompletedAt as number | null) ?? null,
          (session.endedAt as number | null) ?? null,
          (session.updatedAt ?? session.startedAt ?? Date.now()) as number
        )
      );

      // D1 batch limit is 100 statements; chunk if needed
      const BATCH_SIZE = 100;
      for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
        await c.env.DATABASE.batch(stmts.slice(i, i + BATCH_SIZE));
      }

      totalSynced += result.sessions.length;
    } catch (err) {
      projectErrors.push({
        projectId: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({
    totalProjects: projects.length,
    totalSessionsSynced: totalSynced,
    errors: projectErrors,
  });
});

export { adminRoutes };
