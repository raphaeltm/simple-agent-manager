/**
 * Chat session routes — CRUD for project chat sessions and messages.
 *
 * All routes are scoped under /api/projects/:projectId/sessions.
 * Authentication is required for all routes.
 *
 * See: specs/018-project-first-architecture/tasks.md (T027)
 */
import type { ChatSessionTaskEmbed } from '@simple-agent-manager/shared';
import { DEFAULT_CHAT_COMPACT_MODE, DEFAULT_CHAT_SESSION_MESSAGE_LIMIT, DEFAULT_CHAT_SESSION_MESSAGE_MAX, isTaskExecutionStep, isTaskMode } from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { requireRouteParam } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import { getAuth, getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { CreateChatSessionSchema, LinkTaskToChatSchema, parseOptionalBody, SendChatMessageSchema } from '../schemas';
import { resolveTaskAgentProfileHint } from '../services/agent-profile-display';
import * as chatPersistence from '../services/chat-persistence';
import { persistError } from '../services/observability';
import * as projectDataService from '../services/project-data';
import { isTaskStatus } from '../services/task-status';
import { resolveChatAgentState } from './chat-agent-state';
import { chatForkRoutes } from './chat-fork';
import { getChatSessionRouteContext } from './chat-route-context';
import { enrichSessionsWithCreators, getSessionListScope, requireSessionCreator } from './chat-session-ownership';
import { chatStateRoutes } from './chat-state';
import { registerChatStopRoute } from './chat-stop';
import { resolveLiveAgentSessionForChat } from './chat-workspace-resolver';

const chatRoutes = new Hono<{ Bindings: Env }>();

chatRoutes.use('/*', requireAuth(), requireApproved());

type ChatSessionLoadPhase = 'get_session' | 'get_messages';

function isDiagnosticRole(role: string): boolean {
  return role === 'admin' || role === 'superadmin';
}

function serializeDiagnosticError(err: unknown): {
  name: string;
  message: string;
  stack: string | null;
} {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    };
  }

  return {
    name: 'NonError',
    message: String(err),
    stack: null,
  };
}

async function recordChatSessionLoadFailure(
  c: Context<{ Bindings: Env }>,
  input: {
    err: unknown;
    phase: ChatSessionLoadPhase;
    projectId: string;
    sessionId: string;
    userId: string;
  }
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const diagnostic = serializeDiagnosticError(input.err);
  const context = {
    requestId,
    route: 'GET /api/projects/:projectId/sessions/:sessionId',
    phase: input.phase,
    projectId: input.projectId,
    sessionId: input.sessionId,
    userId: input.userId,
    errorName: diagnostic.name,
    errorMessage: diagnostic.message,
  };

  log.error('chat.session_detail_load_failed', {
    ...context,
    stack: diagnostic.stack,
  });

  if (c.env.OBSERVABILITY_DATABASE) {
    await persistError(c.env.OBSERVABILITY_DATABASE, {
      source: 'api',
      level: 'error',
      message: 'chat.session_detail_load_failed',
      stack: diagnostic.stack,
      context,
      userId: input.userId,
      ipAddress: c.req.header('CF-Connecting-IP') ?? null,
      userAgent: c.req.header('User-Agent') ?? null,
    });
  }

  const body: Record<string, unknown> = {
    error: 'CHAT_SESSION_LOAD_FAILED',
    message: 'Failed to load chat session',
    requestId,
    phase: input.phase,
  };

  if (isDiagnosticRole(getAuth(c).user.role)) {
    body.details = {
      errorName: diagnostic.name,
      errorMessage: diagnostic.message,
      stack: diagnostic.stack,
    };
  }

  return c.json(body, 500);
}

/**
 * Resolve the effective message limit for a chat session REST response.
 *
 * Two distinct knobs (see `.claude/rules/03-constitution.md` Principle XI):
 * - `CHAT_SESSION_MESSAGE_LIMIT` — the page size used when no explicit limit is
 *   requested (the 3s poll and load-more pagination). Kept small so polling does
 *   not re-fetch the whole conversation every cycle.
 * - `CHAT_SESSION_MESSAGE_MAX` — the ceiling any request is clamped to. The
 *   client's initial load explicitly requests this so the full conversation
 *   arrives in one request. The 30 MiB RPC size guard in `getMessages()` is the
 *   ultimate cap; oversized sessions keep `hasMore=true` and paginate.
 */
function getSessionMessageLimit(env: Env, requestedLimit?: string): number {
  const configuredDefault = Number.parseInt(env.CHAT_SESSION_MESSAGE_LIMIT || '', 10);
  const defaultLimit = Number.isFinite(configuredDefault) && configuredDefault > 0
    ? configuredDefault
    : DEFAULT_CHAT_SESSION_MESSAGE_LIMIT;
  const configuredMax = Number.parseInt(env.CHAT_SESSION_MESSAGE_MAX || '', 10);
  const maxLimit = Number.isFinite(configuredMax) && configuredMax > 0
    ? configuredMax
    : DEFAULT_CHAT_SESSION_MESSAGE_MAX;
  // Guard against misconfiguration where the default page size exceeds the max.
  // We promote the ceiling to the page size so the default page always fits, but
  // this silently overrides an operator's intended (smaller) ceiling — warn so it
  // is visible in `wrangler tail`.
  if (maxLimit < defaultLimit) {
    log.warn('chat.session_message_limit_misconfigured', {
      defaultLimit,
      maxLimit,
      effectiveMax: defaultLimit,
    });
  }
  const effectiveMax = Math.max(defaultLimit, maxLimit);
  const parsedLimit = Number.parseInt(requestedLimit || '', 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : defaultLimit;
  return Math.min(limit, effectiveMax);
}

function getBeforeCursor(rawBefore?: string): number | null {
  if (!rawBefore) return null;
  const before = Number.parseInt(rawBefore, 10);
  if (!Number.isFinite(before)) {
    throw errors.badRequest('before must be a valid timestamp');
  }
  return before;
}

function getRequestedRoles(rawRoles?: string): string[] | undefined {
  const roles = rawRoles
    ?.split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  return roles && roles.length > 0 ? roles : undefined;
}

function getCompactMode(rawCompact: string | undefined, defaultValue: boolean): boolean {
  if (!rawCompact) return defaultValue;
  const compact = rawCompact.trim().toLowerCase();
  if (compact === 'true' || compact === '1') return true;
  if (compact === 'false' || compact === '0') return false;
  throw errors.badRequest('compact must be true or false');
}

function getMessageOrder(rawOrder?: string): 'asc' | 'desc' {
  if (!rawOrder) return 'desc';
  const order = rawOrder.trim().toLowerCase();
  if (order === 'asc' || order === 'desc') return order;
  throw errors.badRequest('order must be asc or desc');
}

/**
 * GET /api/projects/:projectId/sessions
 * List chat sessions for a project.
 */
chatRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const status = c.req.query('status') || null;
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = parseInt(c.req.query('offset') || '0', 10);
  const scope = getSessionListScope(c.req.query('scope'));
  const createdByUserId = scope === 'my' ? userId : null;

  const result = await projectDataService.listSessions(
    c.env,
    projectId,
    status,
    limit,
    offset,
    null,
    createdByUserId
  );

  return c.json({
    ...result,
    sessions: await enrichSessionsWithCreators(db, result.sessions, userId),
  });
});

/**
 * POST /api/projects/:projectId/sessions
 * Create a new chat session.
 */
chatRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');

  const body = await parseOptionalBody(c.req.raw, CreateChatSessionSchema, {});
  const workspaceId = body.workspaceId?.trim() || null;
  const topic = body.topic?.trim() || null;

  const taskId = ulid();
  const now = new Date().toISOString();
  await db.insert(schema.tasks).values({
    id: taskId, projectId, userId, title: topic || "Conversation",
    status: "queued", executionStep: "session_persistence", taskMode: "conversation",
    triggeredBy: "user", credentialAttributionUserId: userId,
    credentialAttributionSource: "user", createdBy: userId, createdAt: now, updatedAt: now,
  });
  const sessionId = await chatPersistence.createChatSession(
    c.env, projectId, workspaceId, topic, taskId, userId
  );
  await db.update(schema.tasks).set({ chatSessionId: sessionId, workspaceId, updatedAt: now })
    .where(eq(schema.tasks.id, taskId));

  return c.json({ id: sessionId, sessionId, taskId }, 201);
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

  await requireProjectAccess(db, projectId, userId);

  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    throw errors.badRequest('Expected WebSocket upgrade');
  }

  return projectDataService.forwardWebSocket(c.env, projectId, c.req.raw);
});

/**
 * GET /api/projects/:projectId/sessions/:sessionId/state
 * Read the lightweight ACP activity snapshot for a chat session.
 */
chatRoutes.route('/', chatStateRoutes);
chatRoutes.route('/', chatForkRoutes);

/**
 * GET /api/projects/:projectId/sessions/:sessionId
 * Get a single session with its messages (cursor-paginated).
 */
chatRoutes.get('/:sessionId', async (c) => {
  const { db, projectId, sessionId, userId } = await getChatSessionRouteContext(c);

  let session: Awaited<ReturnType<typeof projectDataService.getSession>>;
  try {
    session = await projectDataService.getSession(c.env, projectId, sessionId);
  } catch (err) {
    return recordChatSessionLoadFailure(c, {
      err,
      phase: 'get_session',
      projectId,
      sessionId,
      userId,
    });
  }

  if (!session) {
    throw errors.notFound('Chat session');
  }

  const limit = getSessionMessageLimit(c.env, c.req.query('limit'));
  const beforeParam = c.req.query('before');
  const before = beforeParam ? Number.parseInt(beforeParam, 10) : null;

  const compactDefault = (c.env.CHAT_COMPACT_MODE_DEFAULT ?? '').toLowerCase();
  const compact = compactDefault === 'false' ? false : DEFAULT_CHAT_COMPACT_MODE;

  let messagesResult: Awaited<ReturnType<typeof projectDataService.getMessages>>;
  try {
    messagesResult = await projectDataService.getMessages(
      c.env,
      projectId,
      sessionId,
      limit,
      before,
      undefined,
      compact
    );
  } catch (err) {
    return recordChatSessionLoadFailure(c, {
      err,
      phase: 'get_messages',
      projectId,
      sessionId,
      userId,
    });
  }

  // Embed task summary if session is linked to a task (D1 lookup, best-effort)
  let task: ChatSessionTaskEmbed | null = null;
  const sessionRecord = expectJsonRecord(session, 'chat.session');
  const taskId = typeof sessionRecord.taskId === 'string' ? sessionRecord.taskId : null;
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
          taskMode: schema.tasks.taskMode,
          agentProfileHint: schema.tasks.agentProfileHint,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .limit(1);

      if (taskRow) {
        const agentProfileHint = await resolveTaskAgentProfileHint(db, {
          hint: taskRow.agentProfileHint,
          projectId,
          userId,
        });

        task = {
          id: taskRow.id,
          status: isTaskStatus(taskRow.status) ? taskRow.status : 'draft',
          executionStep: isTaskExecutionStep(taskRow.executionStep) ? taskRow.executionStep : null,
          errorMessage: taskRow.errorMessage ?? null,
          outputBranch: taskRow.outputBranch,
          outputPrUrl: taskRow.outputPrUrl,
          outputSummary: taskRow.outputSummary ?? null,
          finalizedAt: taskRow.finalizedAt ?? null,
          taskMode: isTaskMode(taskRow.taskMode) ? taskRow.taskMode : null,
          agentProfileHint,
        };
      }
    } catch {
      // D1 lookup failure is non-fatal — return session without task
    }
  }

  const { agentSessionId, agentType, state } = await resolveChatAgentState(c.env, {
    projectId,
    sessionId,
    lookupFailureEvent: 'chat.agent_session_id_lookup_failed',
  });

  return c.json({
    session: (await enrichSessionsWithCreators(db, [{ ...session, agentSessionId, agentType, task }], userId))[0],
    messages: messagesResult.messages,
    hasMore: messagesResult.hasMore,
    state,
  });
});

/**
 * GET /api/projects/:projectId/sessions/:sessionId/messages
 * Get persisted messages for a session with optional role filtering.
 *
 * This supports secondary views like the timeline, which need server-backed
 * user turns without forcing the main chat viewport to load every message.
 */
chatRoutes.get('/:sessionId/messages', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Chat session');
  }

  const limit = getSessionMessageLimit(c.env, c.req.query('limit'));
  const before = getBeforeCursor(c.req.query('before'));
  const roles = getRequestedRoles(c.req.query('roles') ?? c.req.query('role'));
  const order = getMessageOrder(c.req.query('order'));

  const compactDefault = (c.env.CHAT_COMPACT_MODE_DEFAULT ?? '').toLowerCase();
  const defaultCompact = compactDefault === 'false' ? false : DEFAULT_CHAT_COMPACT_MODE;
  const compact = getCompactMode(c.req.query('compact'), defaultCompact);

  const messagesResult = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    limit,
    before,
    roles,
    compact,
    order
  );

  return c.json(messagesResult);
});

/**
 * GET /api/projects/:projectId/sessions/:sessionId/messages/:messageId/tool-content
 * Lazy-load the tool_metadata.content array for a single message.
 * Used by compact mode: the session detail route strips tool content to reduce
 * RPC payload size, and the frontend fetches content on demand when users expand
 * individual tool call cards.
 */
chatRoutes.get('/:sessionId/messages/:messageId/tool-content', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const messageId = requireRouteParam(c, 'messageId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

  const content = await projectDataService.getMessageToolContent(
    c.env,
    projectId,
    sessionId,
    messageId
  );

  if (content === null) {
    throw errors.notFound('Message tool content');
  }

  return c.json({ content });
});

registerChatStopRoute(chatRoutes);

/**
 * POST /api/projects/:projectId/sessions/:sessionId/idle-reset
 * Reset the idle cleanup timer for a session (user sent a follow-up).
 */
chatRoutes.post('/:sessionId/idle-reset', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  await requireSessionCreator(c.env, projectId, sessionId, userId);

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

  await requireProjectCapability(db, projectId, userId, 'task:write');
  await requireSessionCreator(c.env, projectId, sessionId, userId);

  const body = await parseOptionalBody(c.req.raw, SendChatMessageSchema, {});
  const content = body.content?.trim();
  if (!content) {
    throw errors.badRequest('content is required');
  }

  // Resolve the live workspace + running agent session, tenant-scoped and
  // fail-fast (see resolveLiveAgentSessionForChat).
  const { workspace, agentSession } = await resolveLiveAgentSessionForChat(db, {
    projectId,
    sessionId,
    userId,
  });

  // Enrich @mentions with agent profile context before forwarding.
  // The enriched message goes to the agent; the clean message was already
  // persisted in chat by the VM agent message reporting flow.
  const { enrichMessageWithMentions } = await import('../services/mention-enrichment');
  const { enrichedMessage } = await enrichMessageWithMentions(content, db, projectId, userId, c.env);

  // Forward the prompt to the VM agent
  const { getCfContainerWakeTimeoutMs, sendPromptToAgentOnNode } = await import('../services/node-agent');
  const result = await sendPromptToAgentOnNode(
    workspace.nodeId,
    workspace.id,
    agentSession.id,
    enrichedMessage,
    c.env,
    userId,
    undefined,
    workspace.nodeRuntime === 'cf-container' && workspace.nodeStatus !== 'running'
      ? { requestTimeoutMs: getCfContainerWakeTimeoutMs(c.env) }
      : undefined
  );

  return c.json(expectJsonRecord(result, 'chat.agent_prompt_result'));
});

/**
 * POST /api/projects/:projectId/sessions/:sessionId/cancel
 * Cancel the current in-flight prompt on the running agent session.
 * Sends a cancel signal to the VM agent which interrupts the agent
 * without tearing down the session — the user can send a follow-up.
 */
chatRoutes.post('/:sessionId/cancel', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  await requireSessionCreator(c.env, projectId, sessionId, userId);

  // Resolve the live workspace + running agent session, tenant-scoped and
  // fail-fast (see resolveLiveAgentSessionForChat).
  const { workspace, agentSession } = await resolveLiveAgentSessionForChat(db, {
    projectId,
    sessionId,
    userId,
  });

  // Forward the cancel to the VM agent
  const { cancelAgentSessionOnNode } = await import('../services/node-agent');
  const result = await cancelAgentSessionOnNode(
    workspace.nodeId,
    workspace.id,
    agentSession.id,
    c.env,
    userId
  );

  // 409 means no prompt in flight — not an error from the user's perspective
  if (!result.success && result.status !== 409) {
    throw errors.internal('Failed to cancel prompt on agent');
  }

  return c.json({
    status: result.success ? 'cancelled' : 'idle',
    message: result.success ? 'Prompt cancel signal sent' : 'No prompt in flight to cancel',
  });
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

  await requireProjectCapability(db, projectId, userId, 'task:write');

  // Verify session exists
  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Session not found');
  }

  // Fetch all messages for the session (up to 1000) — compact=false to include full content for summarization
  const { messages: allMessages } = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    1000,
    null,
    undefined,
    false
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
    c.env,
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

// ─── Session–Idea linking endpoints ─────────────────────────────────────────

/**
 * GET /api/projects/:projectId/sessions/:sessionId/ideas
 * List all ideas linked to a session.
 */
chatRoutes.get('/:sessionId/ideas', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectAccess(db, projectId, userId);

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
chatRoutes.delete('/:sessionId/ideas/:taskId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const taskId = requireRouteParam(c, 'taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');

  await projectDataService.unlinkSessionIdea(c.env, projectId, sessionId, taskId);

  return c.json({ unlinked: true });
});

// Browser-side POST /:sessionId/messages route removed — messages are now
// persisted exclusively by the VM agent via POST /api/workspaces/:id/messages.
// See: specs/021-task-chat-architecture (US1 — Agent-Side Chat Persistence).

export { chatRoutes };
