/**
 * Session–idea linking: list, link, and unlink the ideas attached to a chat session.
 *
 * Mounted by `routes/chat.ts` under `/api/projects/:projectId/sessions`, after its auth middleware.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { LinkTaskToChatSchema, parseOptionalBody } from '../schemas';
import * as projectDataService from '../services/project-data';

const chatIdeaRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/projects/:projectId/sessions/:sessionId/ideas
 * List all ideas linked to a session.
 */
chatIdeaRoutes.get('/:sessionId/ideas', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const links = await projectDataService.getIdeasForSession(c.env, projectId, sessionId);

  // Enrich with task details from D1 in a single query
  let ideas: Array<{
    taskId: string;
    title: string | null;
    status: string | null;
    context: string | null;
    linkedAt: number;
  }> = [];
  if (links.length > 0) {
    const taskRows = await db
      .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status })
      .from(schema.tasks)
      .where(
        inArray(
          schema.tasks.id,
          links.map((l) => l.taskId)
        )
      );

    const taskMap = new Map(taskRows.map((t) => [t.id, t]));

    ideas = links.map((link) => {
      const task = taskMap.get(link.taskId);
      return {
        taskId: link.taskId,
        title: task?.title ?? null,
        status: task?.status ?? null,
        context: link.context,
        linkedAt: link.createdAt,
      };
    });
  }

  return c.json({ ideas, count: ideas.length });
});

/**
 * POST /api/projects/:projectId/sessions/:sessionId/ideas
 * Link an idea to a session.
 */
chatIdeaRoutes.post('/:sessionId/ideas', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');

  const body = await parseOptionalBody(c.req.raw, LinkTaskToChatSchema, {});
  const taskId = body.taskId?.trim();
  if (!taskId) {
    throw errors.badRequest('taskId is required');
  }

  // Verify task exists in this project
  const [task] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.projectId, projectId)))
    .limit(1);

  if (!task) {
    throw errors.notFound('Task not found in this project');
  }

  const context = body.context?.trim().slice(0, 500) ?? null;
  await projectDataService.linkSessionIdea(c.env, projectId, sessionId, taskId, context);

  return c.json({ linked: true }, 201);
});

/**
 * DELETE /api/projects/:projectId/sessions/:sessionId/ideas/:taskId
 * Unlink an idea from a session.
 */
chatIdeaRoutes.delete('/:sessionId/ideas/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');

  await projectDataService.unlinkSessionIdea(c.env, projectId, sessionId, taskId);

  return c.json({ unlinked: true });
});

export { chatIdeaRoutes };
