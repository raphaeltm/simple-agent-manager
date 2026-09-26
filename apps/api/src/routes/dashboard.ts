/**
 * Dashboard API routes.
 *
 * Serves the dashboard's Active Tasks list: the user's most recently active
 * tasks, enriched with session data from per-project Durable Objects.
 */
import {
  type DashboardActiveTasksResponse,
  type DashboardTask,
  DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT,
  DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT,
  DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS,
  type TaskExecutionStep,
  type TaskStatus,
} from '@simple-agent-manager/shared';
import { Hono } from 'hono';

import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { listAgentActivityTasks } from '../services/agent-activity';
import * as projectDataService from '../services/project-data';

const dashboardRoutes = new Hono<{ Bindings: Env }>();

dashboardRoutes.use('/*', requireAuth(), requireApproved());

/**
 * When a task last did something: its newest message or, before it has one,
 * when it started or was submitted. Ranking on messages alone would bury a
 * task submitted a moment ago beneath every dormant session that ever spoke.
 */
function lastActivityAt(task: DashboardTask): number {
  const submittedAt = Date.parse(task.startedAt ?? task.createdAt);
  return Math.max(task.lastMessageAt ?? 0, Number.isFinite(submittedAt) ? submittedAt : 0);
}

/** The `limit` most recently active tasks, newest first; ties break on id. */
function mostRecentlyActive(tasks: DashboardTask[], limit: number): DashboardTask[] {
  return tasks
    .map((task) => ({ task, activityAt: lastActivityAt(task) }))
    .sort((a, b) => b.activityAt - a.activityAt || a.task.id.localeCompare(b.task.id))
    .slice(0, limit)
    .map(({ task }) => task);
}

dashboardRoutes.get('/active-tasks', async (c) => {
  const userId = getUserId(c);

  const inactiveThresholdMs = parsePositiveInt(
    c.env.DASHBOARD_INACTIVE_THRESHOLD_MS,
    DEFAULT_DASHBOARD_INACTIVE_THRESHOLD_MS
  );
  const displayLimit = parsePositiveInt(
    c.env.DASHBOARD_ACTIVE_TASK_LIMIT,
    DEFAULT_DASHBOARD_ACTIVE_TASK_LIMIT
  );
  // Each project's candidates are resolved by one `IN (...)` lookup in its
  // Durable Object, and Cloudflare SQL rejects a statement's 101st bound parameter.
  const candidateLimit = Math.min(
    parsePositiveInt(
      c.env.DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT,
      DEFAULT_DASHBOARD_ACTIVE_TASK_CANDIDATE_LIMIT
    ),
    D1_MAX_BOUND_PARAMETERS
  );

  // Message recency lives in each project's Durable Object, not in D1, so every
  // candidate is enriched and ranked before the display limit applies. Capping
  // this read instead would keep the most recently *started* tasks and drop an
  // older conversation that is still in use.
  const rows = await listAgentActivityTasks(c.env, {
    userId,
    activeOnly: true,
    limit: candidateLimit,
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

  return c.json({
    tasks: mostRecentlyActive(dashboardTasks, displayLimit),
  } satisfies DashboardActiveTasksResponse);
});

export { dashboardRoutes };
