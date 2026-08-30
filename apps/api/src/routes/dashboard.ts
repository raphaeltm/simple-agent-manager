/**
 * Dashboard API routes.
 *
 * Provides aggregated views of active tasks with session enrichment
 * from per-project Durable Objects.
 */
import {
  type DashboardActiveTasksResponse,
  type DashboardTask,
  DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT,
  DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS,
  type TaskExecutionStep,
  type TaskStatus,
} from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { listAgentActivityTasks } from '../services/agent-activity';
import * as projectDataService from '../services/project-data';

const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.use('/*', requireAuth(), requireApproved());

dashboardRoutes.get('/active-tasks', async (c) => {
  const userId = getUserId(c);

  const inactiveThresholdMs = parsePositiveInt(
    c.env.DASHBOARD_INACTIVE_THRESHOLD_MS,
    DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS
  );
  const activeTaskLimit = parsePositiveInt(
    c.env.DASHBOARD_ACTIVE_TASK_LIMIT,
    DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT
  );

  const rows = await listAgentActivityTasks(c.env, {
    userId,
    activeOnly: true,
    limit: activeTaskLimit,
  });

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
  const sessionMap = new Map<
    string,
    { sessionId: string; lastMessageAt: number | null; messageCount: number }
  >();

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
      log.warn('dashboard.do_fetch_failed', { error: String(result.reason) });
    }
  }

  const now = Date.now();

  // Build enriched task list
  const dashboardTasks: DashboardTask[] = rows.map((row) => {
    const sessionInfo = sessionMap.get(row.id);
    const lastMessageAt = sessionInfo?.lastMessageAt ?? null;
    const isActive = lastMessageAt != null && now - lastMessageAt < inactiveThresholdMs;

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
      agentActivityState: row.agentActivityState,
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
