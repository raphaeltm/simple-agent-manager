/**
 * Chat session routes — CRUD for project chat sessions and messages.
 *
 * All routes are scoped under /api/projects/:projectId/sessions.
 * Authentication is required for all routes.
 *
 * See: specs/018-project-first-architecture/tasks.md (T027)
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { isTaskExecutionStep } from '@simple-agent-manager/shared';
import type { ChatSessionTaskEmbed } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import { getUserId, requireAuth, requireApproved } from '../middleware/auth';
import { requireOwnedProject } from '../middleware/project-auth';
import { errors } from '../middleware/error';
import * as schema from '../db/schema';
import * as chatPersistence from '../services/chat-persistence';
import * as projectDataService from '../services/project-data';
import { isTaskStatus } from '../services/task-status';

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

chatRoutes.use('/*', requireAuth(), requireApproved());

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
 * GET /api/projects/:projectId/sessions/ws
 * WebSocket upgrade — streams real-time events (new messages, session changes, activity)
 * from the project's Durable Object to the connected client.
 *
 * NOTE: This route MUST be defined before /:sessionId to avoid 'ws' being
 * captured as a sessionId parameter.
 */
chatRoutes.get('/ws', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    throw errors.badRequest('Expected WebSocket upgrade');
  }

  return projectDataService.forwardWebSocket(c.env, projectId, c.req.raw);
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

  // Embed task summary if session is linked to a task (D1 lookup, best-effort)
  let task: ChatSessionTaskEmbed | null = null;
  const taskId = (session as Record<string, unknown>).taskId as string | null;
  if (taskId) {
    try {
      const [taskRow] = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          executionStep: schema.tasks.executionStep,
          outputBranch: schema.tasks.outputBranch,
          outputPrUrl: schema.tasks.outputPrUrl,
          finalizedAt: schema.tasks.finalizedAt,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .limit(1);

      if (taskRow) {
        task = {
          id: taskRow.id,
          status: isTaskStatus(taskRow.status) ? taskRow.status : 'draft',
          executionStep: isTaskExecutionStep(taskRow.executionStep) ? taskRow.executionStep : null,
          outputBranch: taskRow.outputBranch,
          outputPrUrl: taskRow.outputPrUrl,
          finalizedAt: taskRow.finalizedAt ?? null,
        };
      }
    } catch {
      // D1 lookup failure is non-fatal — return session without task
    }
  }

  return c.json({
    session: { ...session, task },
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
 * POST /api/projects/:projectId/sessions/:sessionId/idle-reset
 * Reset the idle cleanup timer for a session (user sent a follow-up).
 */
chatRoutes.post('/:sessionId/idle-reset', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const result = await projectDataService.resetIdleCleanup(c.env, projectId, sessionId);

  return c.json({ cleanupAt: result.cleanupAt });
});

// Browser-side POST /:sessionId/messages route removed — messages are now
// persisted exclusively by the VM agent via POST /api/workspaces/:id/messages.
// See: specs/021-task-chat-architecture (US1 — Agent-Side Chat Persistence).

export { chatRoutes };
