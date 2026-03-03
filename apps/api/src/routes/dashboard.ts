/**
 * Dashboard API routes.
 *
 * Provides aggregated views of active tasks with session enrichment
 * from per-project Durable Objects.
 */
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS,
  type DashboardActiveTasksResponse,
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

export { dashboardRoutes };
