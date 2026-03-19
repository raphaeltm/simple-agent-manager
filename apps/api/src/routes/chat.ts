/**
 * Chat session routes — CRUD for project chat sessions and messages.
 *
 * All routes are scoped under /api/projects/:projectId/sessions.
 * Authentication is required for all routes.
 *
 * See: specs/018-project-first-architecture/tasks.md (T027)
 */
import { Hono } from 'hono';
import { eq, and, inArray, desc } from 'drizzle-orm';
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

  const limit = Math.min(parseInt(c.req.query('limit') || '1000', 10), 5000);
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
          errorMessage: schema.tasks.errorMessage,
          outputBranch: schema.tasks.outputBranch,
          outputPrUrl: schema.tasks.outputPrUrl,
          outputSummary: schema.tasks.outputSummary,
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
          errorMessage: taskRow.errorMessage ?? null,
          outputBranch: taskRow.outputBranch,
          outputPrUrl: taskRow.outputPrUrl,
          outputSummary: taskRow.outputSummary ?? null,
          finalizedAt: taskRow.finalizedAt ?? null,
        };
      }
    } catch {
      // D1 lookup failure is non-fatal — return session without task
    }
  }

  // Look up the most recent agent session ID (ULID) from D1 so the UI can
  // route ACP WebSocket to the correct VM agent session instead of creating a
  // duplicate.  We intentionally do NOT filter by status='running' — the
  // agent session may be suspended (idle timeout) or briefly in another
  // transient state.  The VM agent auto-resumes suspended sessions on
  // WebSocket attach (agent_ws.go:96-117), so the browser should always
  // reconnect with the original agent session ID to preserve conversation
  // context.  Filtering by status caused the UI to fall back to the chat
  // session ID, which created a new SessionHost on the VM and wiped the
  // conversation history.
  let agentSessionId: string | null = null;
  const workspaceId = (session as Record<string, unknown>).workspaceId as string | null;
  if (workspaceId) {
    try {
      const [agentRow] = await db
        .select({ id: schema.agentSessions.id })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.workspaceId, workspaceId))
        .orderBy(desc(schema.agentSessions.createdAt))
        .limit(1);
      if (agentRow) {
        agentSessionId = agentRow.id;
      }
    } catch (err) {
      // D1 lookup failure is non-fatal — UI falls back to chat session ID
      console.warn('Failed to fetch agentSessionId for workspace', workspaceId, err);
    }
  }

  return c.json({
    session: { ...session, agentSessionId, task },
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

/**
 * POST /api/projects/:projectId/sessions/:sessionId/prompt
 * Forward a follow-up prompt to the running agent session on the VM.
 * Looks up workspace + agent session from D1, then calls the VM agent.
 */
chatRoutes.post('/:sessionId/prompt', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<{ content?: string }>().catch((): { content?: string } => ({}));
  const content = body.content?.trim();
  if (!content) {
    throw errors.badRequest('content is required');
  }

  // Find the workspace linked to this chat session, joining with nodes
  // to verify the node is still active. When a node is destroyed (e.g.,
  // after task timeout), its DNS record is cleaned up but the workspace
  // may still be marked as 'running' in D1. Without this check, the
  // request to the VM agent would hit the wildcard DNS record and loop
  // back to this Worker, producing a confusing 404.
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      nodeId: schema.workspaces.nodeId,
      nodeStatus: schema.nodes.status,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.workspaces.nodeId, schema.nodes.id))
    .where(
      and(
        eq(schema.workspaces.chatSessionId, sessionId),
        inArray(schema.workspaces.status, ['running', 'recovery'])
      )
    )
    .limit(1);

  if (!workspace || !workspace.nodeId) {
    throw errors.notFound('No active workspace found for this session');
  }

  // Verify the node is still reachable — prevents requests to destroyed VMs
  // whose DNS records no longer exist (would loop back via wildcard DNS).
  // Allow 'active' (in use) and 'warm' (idle but still running) nodes.
  if (workspace.nodeStatus !== 'active' && workspace.nodeStatus !== 'warm') {
    throw errors.conflict(
      'The workspace node is no longer running. Start a new chat to create a fresh workspace.'
    );
  }

  // Find the running agent session on that workspace
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.status, 'running')
      )
    )
    .limit(1);

  if (!agentSession) {
    throw errors.notFound('No running agent session found');
  }

  // Forward the prompt to the VM agent
  const { sendPromptToAgentOnNode } = await import('../services/node-agent');
  const result = await sendPromptToAgentOnNode(
    workspace.nodeId,
    workspace.id,
    agentSession.id,
    content,
    c.env,
    userId
  );

  return c.json(result as Record<string, unknown>);
});

/**
 * POST /api/projects/:projectId/sessions/:sessionId/summarize
 * Generate a context summary from a session's message history.
 * Used for conversation forking — the UI calls this to get a summary,
 * shows it for review, then submits as contextSummary when creating a new task.
 */
chatRoutes.post('/:sessionId/summarize', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  // Verify session exists
  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Session not found');
  }

  // Fetch all messages for the session (up to 1000)
  const { messages: allMessages } = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    1000,
    null
  );

  if (allMessages.length === 0) {
    throw errors.badRequest('Session has no messages');
  }

  // Look up task metadata for enriched context
  let taskContext: import('../services/session-summarize').TaskContext | undefined;
  const taskId = session.taskId as string | null;
  if (taskId) {
    try {
      const [taskRow] = await db
        .select({
          title: schema.tasks.title,
          description: schema.tasks.description,
          outputBranch: schema.tasks.outputBranch,
          outputPrUrl: schema.tasks.outputPrUrl,
          outputSummary: schema.tasks.outputSummary,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .limit(1);

      if (taskRow) {
        taskContext = {
          title: taskRow.title ?? undefined,
          description: taskRow.description ?? undefined,
          outputBranch: taskRow.outputBranch ?? undefined,
          outputPrUrl: taskRow.outputPrUrl ?? undefined,
          outputSummary: taskRow.outputSummary ?? undefined,
        };
      }
    } catch {
      // Task lookup failure is non-fatal — summarize without task context
    }
  }

  // Generate summary
  const { summarizeSession, getSummarizeConfig } = await import('../services/session-summarize');
  const config = getSummarizeConfig(c.env);
  const result = await summarizeSession(
    c.env.AI,
    allMessages.map((m) => ({
      role: m.role as string,
      content: m.content as string,
      created_at: m.createdAt as number,
    })),
    config,
    taskContext
  );

  return c.json(result);
});

// ─── Session–Idea linking endpoints ───────────────────────────────────────────

/**
 * GET /api/projects/:projectId/sessions/:sessionId/ideas
 * List all ideas linked to a session.
 */
chatRoutes.get('/:sessionId/ideas', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const links = await projectDataService.getIdeasForSession(c.env, projectId, sessionId);

  // Enrich with task details from D1 in a single query
  let ideas: Array<{ taskId: string; title: string | null; status: string | null; context: string | null; linkedAt: number }> = [];
  if (links.length > 0) {
    const taskRows = await db
      .select({ id: schema.tasks.id, title: schema.tasks.title, status: schema.tasks.status })
      .from(schema.tasks)
      .where(inArray(schema.tasks.id, links.map((l) => l.taskId)));

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
chatRoutes.post('/:sessionId/ideas', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<{ taskId?: string; context?: string }>().catch(
    (): { taskId?: string; context?: string } => ({})
  );
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
chatRoutes.delete('/:sessionId/ideas/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  await projectDataService.unlinkSessionIdea(c.env, projectId, sessionId, taskId);

  return c.json({ unlinked: true });
});

// Browser-side POST /:sessionId/messages route removed — messages are now
// persisted exclusively by the VM agent via POST /api/workspaces/:id/messages.
// See: specs/021-task-chat-architecture (US1 — Agent-Side Chat Persistence).

export { chatRoutes };
