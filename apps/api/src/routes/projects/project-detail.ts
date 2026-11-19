import type { ProjectDetailResponse, TaskStatus } from '@simple-agent-manager/shared';
import { and, count, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toProjectResponse } from '../../lib/mappers';
import { getUserId } from '../../middleware/auth';
import { requireProjectAccess } from '../../middleware/project-auth';
import { resolveAdminSetting } from '../../services/admin-settings';
import { withDeadline } from '../../services/fetch-timeout';
import * as projectDataService from '../../services/project-data';
import { getProjectMultiplayerState } from '../../services/project-multiplayer';

export function registerProjectDetailRoute(crudRoutes: Hono<{ Bindings: Env }>) {
  crudRoutes.get('/:id', async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });

    const project = await requireProjectAccess(db, projectId, userId);

    const includeRecent = c.req.query('include')?.split(',').includes('recent') ?? false;
    const recent = async () => {
      if (!includeRecent) return { recentSessions: [], recentActivity: [] };
      try {
        const timeoutMs = Number(
          await resolveAdminSetting(c.env, 'performance.projectRecentTimeoutMs')
        );
        const [sessions, activity] = await withDeadline(
          () =>
            Promise.all([
              projectDataService.listSessions(c.env, project.id, null, 5, 0),
              projectDataService.listActivityEvents(c.env, project.id, null, 10, null),
            ]),
          timeoutMs,
          c.req.raw.signal
        );
        return { recentSessions: sessions.sessions, recentActivity: activity.events };
      } catch (err) {
        log.error('project.do_fetch_failed', {
          projectId: project.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return { recentSessions: [], recentActivity: [] };
      }
    };
    const [
      taskCountsRows,
      linkedWorkspacesRow,
      activeWorkspaceCountRow,
      multiplayerState,
      recentData,
    ] = await Promise.all([
      db
        .select({ status: schema.tasks.status, count: count() })
        .from(schema.tasks)
        .where(eq(schema.tasks.projectId, project.id))
        .groupBy(schema.tasks.status),
      db
        .select({ count: sql<number>`count(distinct ${schema.tasks.workspaceId})` })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.projectId, project.id), isNotNull(schema.tasks.workspaceId)))
        .limit(1),
      db
        .select({ count: count() })
        .from(schema.workspaces)
        .where(
          and(eq(schema.workspaces.projectId, project.id), eq(schema.workspaces.status, 'running'))
        ),
      getProjectMultiplayerState(db, project.id),
      recent(),
    ]);
    const taskCountsByStatus: Partial<Record<TaskStatus, number>> = {};
    for (const row of taskCountsRows)
      taskCountsByStatus[row.status as TaskStatus] = Number(row.count);
    const { recentSessions, recentActivity } = recentData;

    const response: ProjectDetailResponse = {
      ...toProjectResponse(project),
      multiplayerActive: multiplayerState.multiplayerActive,
      summary: {
        taskCountsByStatus,
        linkedWorkspaces: linkedWorkspacesRow[0]?.count ?? 0,
        activeWorkspaceCount: activeWorkspaceCountRow[0]?.count ?? 0,
        activeSessionCount: project.activeSessionCount ?? 0,
        lastActivityAt: project.lastActivityAt ?? null,
      },
      recentSessions,
      recentActivity,
    } as ProjectDetailResponse & { recentSessions: unknown[]; recentActivity: unknown[] };

    return c.json(response);
  });
}
