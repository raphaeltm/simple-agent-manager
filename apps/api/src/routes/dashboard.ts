/**
 * Dashboard API routes.
 *
 * Provides aggregated views of active tasks with session enrichment
 * from per-project Durable Objects, plus recently completed tasks.
 */
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS,
  DEFAULT_DASHBOARD_RECENT_TASKS_LIMIT,
  DEFAULT_DASHBOARD_RECENT_TASKS_WINDOW_MS,
  type DashboardActiveTasksResponse,
  type DashboardRecentTask,
  type DashboardRecentTasksResponse,
  type DashboardTask,
  type TaskExecutionStep,
  type TaskStatus,
} from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { getUserId, requireAuth, requireApproved } from '../middleware/auth';
import * as projectDataService from '../services/project-data';

const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.use('/*', requireAuth(), requireApproved());

const ACTIVE_TASK_STATUSES: TaskStatus[] = ['queued', 'delegated', 'in_progress'];
const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

dashboardRoutes.get('/active-tasks', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const inactiveThresholdMs = parseInt(
    c.env.DASHBOARD_INACTIVE_THRESHOLD_MS ?? '',
    10
  ) || DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS;

  // Fetch all tasks in active states for this user, joined with project names
  const rows = await db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
      executionStep: schema.tasks.executionStep,
      projectId: schema.tasks.projectId,
      projectName: schema.projects.name,
      createdAt: schema.tasks.createdAt,
      startedAt: schema.tasks.startedAt,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.tasks.userId, userId),
        inArray(schema.tasks.status, ACTIVE_TASK_STATUSES)
      )
    )
    .limit(100);

  if (rows.length === 0) {
    return c.json({ tasks: [] } satisfies DashboardActiveTasksResponse);
  }

  // Group task IDs by project for batch DO calls
  const tasksByProject = new Map<string, typeof rows>();
  for (const row of rows) {
    const existing = tasksByProject.get(row.projectId) ?? [];
    existing.push(row);
    tasksByProject.set(row.projectId, existing);
  }

  // Fetch session data from each project's DO in parallel
  const sessionMap = new Map<string, { sessionId: string; lastMessageAt: number | null; messageCount: number }>();

  const doResults = await Promise.allSettled(
    Array.from(tasksByProject.entries()).map(async ([projectId, tasks]) => {
      const taskIds = tasks.map((t) => t.id);
      const sessions = await projectDataService.getSessionsByTaskIds(c.env, projectId, taskIds);
      for (const session of sessions) {
        const taskId = session.taskId as string;
        if (taskId) {
          sessionMap.set(taskId, {
            sessionId: session.id as string,
            lastMessageAt: (session.lastMessageAt as number) ?? null,
            messageCount: (session.messageCount as number) ?? 0,
          });
        }
      }
    })
  );

  // Log any DO failures but don't fail the request
  for (const result of doResults) {
    if (result.status === 'rejected') {
      console.warn('Dashboard: failed to fetch session data from DO:', result.reason);
    }
  }

  const now = Date.now();

  // Build enriched task list
  const dashboardTasks: DashboardTask[] = rows.map((row) => {
    const sessionInfo = sessionMap.get(row.id);
    const lastMessageAt = sessionInfo?.lastMessageAt ?? null;
    const isActive = lastMessageAt != null && (now - lastMessageAt) < inactiveThresholdMs;

    return {
      id: row.id,
      title: row.title,
      status: row.status as TaskStatus,
      executionStep: (row.executionStep as TaskExecutionStep) ?? null,
      projectId: row.projectId,
      projectName: row.projectName,
      sessionId: sessionInfo?.sessionId ?? null,
      createdAt: row.createdAt,
      startedAt: row.startedAt ?? null,
      lastMessageAt,
      messageCount: sessionInfo?.messageCount ?? 0,
      isActive,
    };
  });

  // Sort by lastMessageAt descending (tasks with messages first, then by createdAt)
  dashboardTasks.sort((a, b) => {
    if (a.lastMessageAt != null && b.lastMessageAt != null) {
      return b.lastMessageAt - a.lastMessageAt;
    }
    if (a.lastMessageAt != null) return -1;
    if (b.lastMessageAt != null) return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return c.json({ tasks: dashboardTasks } satisfies DashboardActiveTasksResponse);
});

dashboardRoutes.get('/recent-tasks', async (c) => {
  const userId = getUserId(c);

  const limit = Math.min(
    parseInt(c.env.DASHBOARD_RECENT_TASKS_LIMIT ?? '', 10) || DEFAULT_DASHBOARD_RECENT_TASKS_LIMIT,
    50
  );
  const windowMs = parseInt(
    c.env.DASHBOARD_RECENT_TASKS_WINDOW_MS ?? '', 10
  ) || DEFAULT_DASHBOARD_RECENT_TASKS_WINDOW_MS;

  const cutoff = new Date(Date.now() - windowMs).toISOString();

  // Fetch recently completed/failed/cancelled tasks with project names
  const rows = await c.env.DATABASE.prepare(
    `SELECT t.id, t.title, t.status, t.project_id, p.name AS project_name,
            t.created_at, t.completed_at, t.output_branch, t.output_pr_url, t.output_summary
     FROM tasks t
     INNER JOIN projects p ON t.project_id = p.id
     WHERE t.user_id = ?
       AND t.status IN ('completed', 'failed', 'cancelled')
       AND t.completed_at >= ?
     ORDER BY t.completed_at DESC
     LIMIT ?`
  ).bind(userId, cutoff, limit).all<{
    id: string;
    title: string;
    status: string;
    project_id: string;
    project_name: string;
    created_at: string;
    completed_at: string | null;
    output_branch: string | null;
    output_pr_url: string | null;
    output_summary: string | null;
  }>();

  // Fetch session IDs for these tasks from project DOs (best-effort)
  const tasksByProject = new Map<string, string[]>();
  for (const row of rows.results) {
    const existing = tasksByProject.get(row.project_id) ?? [];
    existing.push(row.id);
    tasksByProject.set(row.project_id, existing);
  }

  const sessionMap = new Map<string, string>();
  const doResults = await Promise.allSettled(
    Array.from(tasksByProject.entries()).map(async ([projectId, taskIds]) => {
      const sessions = await projectDataService.getSessionsByTaskIds(c.env, projectId, taskIds);
      for (const session of sessions) {
        const taskId = session.taskId as string;
        if (taskId) {
          sessionMap.set(taskId, session.id as string);
        }
      }
    })
  );

  for (const result of doResults) {
    if (result.status === 'rejected') {
      console.warn('Dashboard: failed to fetch session data for recent tasks:', result.reason);
    }
  }

  const recentTasks: DashboardRecentTask[] = rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    projectId: row.project_id,
    projectName: row.project_name,
    sessionId: sessionMap.get(row.id) ?? null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    outputBranch: row.output_branch,
    outputPrUrl: row.output_pr_url,
    outputSummary: row.output_summary,
  }));

  return c.json({ tasks: recentTasks } satisfies DashboardRecentTasksResponse);
});

export { dashboardRoutes };
