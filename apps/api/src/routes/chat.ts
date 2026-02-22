/**
 * Chat session routes — CRUD for project chat sessions and messages.
 *
 * All routes are scoped under /api/projects/:projectId/sessions.
 * Authentication is required for all routes.
 *
 * See: specs/018-project-first-architecture/tasks.md (T027)
 */
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../index';
import { getUserId, requireAuth } from '../middleware/auth';
import { requireOwnedProject } from '../middleware/project-auth';
import { errors } from '../middleware/error';
import * as schema from '../db/schema';
import * as chatPersistence from '../services/chat-persistence';
import * as projectDataService from '../services/project-data';
import type { PersistMessageRequest } from '@simple-agent-manager/shared';

const chatRoutes = new Hono<{ Bindings: Env }>();

function requireRouteParam(
  c: { req: { param: (name: string) => string | undefined } },
  name: string
): string {
  const value = c.req.param(name);
  if (!value) {
    throw errors.badRequest(`${name} is required`);
  }
  return value;
}

chatRoutes.use('/*', requireAuth());

/**
 * GET /api/projects/:projectId/sessions
 * List chat sessions for a project.
 */
chatRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const status = c.req.query('status') || null;
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const result = await projectDataService.listSessions(c.env, projectId, status, limit, offset);

  return c.json(result);
});

/**
 * POST /api/projects/:projectId/sessions
 * Create a new chat session.
 */
chatRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<{ workspaceId?: string; topic?: string }>().catch(
    (): { workspaceId?: string; topic?: string } => ({})
  );
  const workspaceId = body.workspaceId?.trim() || null;
  const topic = body.topic?.trim() || null;

  const sessionId = await chatPersistence.createChatSession(c.env, projectId, workspaceId, topic);

  return c.json({ id: sessionId }, 201);
});

/**
 * GET /api/projects/:projectId/sessions/:sessionId
 * Get a single session with its messages (cursor-paginated).
 */
chatRoutes.get('/:sessionId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Chat session');
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10), 500);
  const beforeParam = c.req.query('before');
  const before = beforeParam ? parseInt(beforeParam, 10) : null;

  const messagesResult = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    limit,
    before
  );

  return c.json({
    session,
    messages: messagesResult.messages,
    hasMore: messagesResult.hasMore,
  });
});

/**
 * POST /api/projects/:projectId/sessions/:sessionId/stop
 * Stop a chat session.
 */
chatRoutes.post('/:sessionId/stop', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  await chatPersistence.stopChatSession(c.env, projectId, sessionId);

  return c.json({ status: 'stopped' });
});

/**
 * POST /api/projects/:projectId/sessions/:sessionId/messages
 * Persist a message to a chat session.
 */
chatRoutes.post('/:sessionId/messages', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<PersistMessageRequest>();

  if (!body.role || !body.content) {
    throw errors.badRequest('role and content are required');
  }

  const messageId = await chatPersistence.persistMessage(
    c.env,
    projectId,
    sessionId,
    body.role,
    body.content,
    body.toolMetadata || null
  );

  return c.json({ id: messageId }, 201);
});

export { chatRoutes };
