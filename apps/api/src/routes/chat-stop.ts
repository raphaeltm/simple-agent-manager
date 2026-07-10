import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { getUserId } from '../middleware/auth';
import { requireProjectCapability } from '../middleware/project-auth';
import * as chatPersistence from '../services/chat-persistence';
import { isExecutableTaskStatus, isTaskStatus } from '../services/task-status';
import { cleanupTerminalTaskResources, type TerminalTaskCleanupStatus } from '../services/task-terminal-cleanup';
import { cleanupWorkspaceForDeletion } from '../services/workspace-cleanup';
import { requireSessionCreator } from './chat-session-ownership';

export function registerChatStopRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  /**
   * POST /api/projects/:projectId/sessions/:sessionId/stop
   * Stop a chat session.
   */
  chatRoutes.post('/:sessionId/stop', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    const session = await requireSessionCreator(c.env, projectId, sessionId, userId);

    const taskId = typeof session.taskId === 'string' && session.taskId.length > 0
      ? session.taskId
      : null;
    const workspaceId = typeof session.workspaceId === 'string' && session.workspaceId.length > 0
      ? session.workspaceId
      : null;

    let workspace: schema.Workspace | undefined;
    if (!taskId && workspaceId) {
      const [workspaceById] = await db
        .select()
        .from(schema.workspaces)
        .where(and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.userId, userId),
          eq(schema.workspaces.projectId, projectId)
        ))
        .limit(1);
      workspace = workspaceById;
    }

    if (!taskId && !workspace) {
      const [workspaceBySession] = await db
        .select()
        .from(schema.workspaces)
        .where(and(
          eq(schema.workspaces.chatSessionId, sessionId),
          eq(schema.workspaces.userId, userId),
          eq(schema.workspaces.projectId, projectId)
        ))
        .limit(1);
      workspace = workspaceBySession;
    }

    if (taskId) {
      const [task] = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          errorMessage: schema.tasks.errorMessage,
        })
        .from(schema.tasks)
        .where(and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.projectId, projectId),
          eq(schema.tasks.userId, userId)
        ))
        .limit(1);

      const terminalStatus = task?.status === 'completed' || task?.status === 'failed' || task?.status === 'cancelled'
        ? task.status
        : null;

      if (task && !terminalStatus && isTaskStatus(task.status) && isExecutableTaskStatus(task.status)) {
        const now = new Date().toISOString();
        await db.update(schema.tasks)
          .set({
            status: 'cancelled',
            errorMessage: 'Archived by user',
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, taskId));
        await db.insert(schema.taskStatusEvents).values({
          id: ulid(),
          taskId,
          fromStatus: task.status,
          toStatus: 'cancelled',
          actorType: 'user',
          actorId: userId,
          reason: 'Archived by user',
          createdAt: now,
        });
      }

      const cleanupStatus: TerminalTaskCleanupStatus = terminalStatus ?? 'cancelled';
      await cleanupTerminalTaskResources(c.env, taskId, {
        status: cleanupStatus,
        errorMessage: cleanupStatus === 'failed' ? (task?.errorMessage ?? null) : 'Archived by user',
        logContext: { projectId, sessionId, stopPath: 'task-session' },
      });
    } else if (workspace) {
      await cleanupWorkspaceForDeletion({
        db,
        env: c.env,
        workspace,
        userId,
        logContext: { projectId, sessionId, stopPath: 'session' },
      });
    } else {
      await chatPersistence.stopChatSession(c.env, projectId, sessionId);
    }

    return c.json({ status: 'stopped', workspaceDeleted: Boolean(workspace || taskId) });
  });
}
