import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { requireProjectCapability } from '../middleware/project-auth';
import * as chatPersistence from '../services/chat-persistence';
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

    if (!taskId && workspace) {
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

    return c.json({ status: 'stopped', workspaceDeleted: Boolean(!taskId && workspace) });
  });
}
