/**
 * Chat session routes — CRUD for project chat sessions and messages.
 *
 * All routes are scoped under /api/projects/:projectId/sessions.
 * Authentication is required for all routes.
 *
 * See: specs/018-project-first-architecture/tasks.md (T027)
 */
import type { ChatSessionTaskEmbed } from '@simple-agent-manager/shared';
import {
  DEFAULT_CHAT_COMPACT_MODE,
  DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT,
  isTaskExecutionStep,
  isTaskMode,
} from '@simple-agent-manager/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import {
  CreateChatSessionSchema,
  LinkTaskToChatSchema,
  parseOptionalBody,
  ResolveAttentionAnswerSchema,
} from '../schemas';
import { resolveTaskAgentProfileHint } from '../services/agent-profile-display';
import * as chatPersistence from '../services/chat-persistence';
import * as projectDataService from '../services/project-data';
import { publicPlacementExplanationJson } from '../services/public-placement-explanation';
import { isTaskStatus } from '../services/task-status';
import { attachWakeState } from './chat/wake-state';
import { resolveChatAgentState } from './chat-agent-state';
import { registerChatCancelRoute } from './chat-cancel';
import { registerChatCommentDirectiveRoute } from './chat-comment-directives';
import { chatCommentRoutes } from './chat-comments';
import { chatForkRoutes } from './chat-fork';
import { recordChatSessionLoadFailure } from './chat-load-diagnostics';
import {
  getCompactMode,
  getMessageCursor,
  getMessageOrder,
  getRequestedRoles,
  getSessionMessageLimit,
} from './chat-message-query';
import { preparePromptForLiveAgent, sendPreparedPromptToLiveAgent } from './chat-prompt-forward';
import { registerChatPromptRoute } from './chat-prompt-route';
import { getChatSessionRouteContext } from './chat-route-context';
import { registerChatSessionListRoute } from './chat-session-list';
import { enrichSessionsWithCreators, requireSessionCreator } from './chat-session-ownership';
import { chatStateRoutes } from './chat-state';
import { registerChatStopRoute } from './chat-stop';

const chatRoutes = new Hono<{ Bindings: Env }>();

chatRoutes.use('/*', requireAuth(), requireApproved());

registerChatSessionListRoute(chatRoutes);

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
    id: taskId,
    projectId,
    userId,
    title: topic || 'Conversation',
    status: 'queued',
    executionStep: 'session_persistence',
    taskMode: 'conversation',
    triggeredBy: 'user',
    credentialAttributionUserId: userId,
    credentialAttributionSource: 'user',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = await chatPersistence.createChatSession(
    c.env,
    projectId,
    workspaceId,
    topic,
    taskId,
    userId
  );
  await db
    .update(schema.tasks)
    .set({ chatSessionId: sessionId, workspaceId, updatedAt: now })
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
  const before = getMessageCursor('before', c.req.query('before'));
  const after = getMessageCursor('after', c.req.query('after'));
  const configuredDeltaLimit = Number.parseInt(c.env.CHAT_SESSION_DELTA_MESSAGE_LIMIT || '', 10);
  const deltaLimit =
    Number.isFinite(configuredDeltaLimit) && configuredDeltaLimit > 0
      ? configuredDeltaLimit
      : DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT;
  const effectiveLimit = after !== null && c.req.query('limit') === undefined ? deltaLimit : limit;

  const compactDefault = (c.env.CHAT_COMPACT_MODE_DEFAULT ?? '').toLowerCase();
  const compact = compactDefault === 'false' ? false : DEFAULT_CHAT_COMPACT_MODE;

  let messagesResult: Awaited<ReturnType<typeof projectDataService.getMessages>>;
  try {
    messagesResult = await projectDataService.getMessages(
      c.env,
      projectId,
      sessionId,
      effectiveLimit,
      before,
      after,
      undefined,
      compact,
      getMessageOrder(undefined, { before, after })
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
          placementExplanationJson: schema.tasks.placementExplanationJson,
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
          placementExplanationJson: publicPlacementExplanationJson(
            taskRow.placementExplanationJson
          ),
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

  const stateWithRecovery = await attachWakeState(db, state, {
    projectId,
    sessionId,
    sessionStatus: sessionRecord.status,
  });

  return c.json({
    session: (
      await enrichSessionsWithCreators(
        db,
        [{ ...session, agentSessionId, agentType, task }],
        userId
      )
    )[0],
    messages: messagesResult.messages,
    hasMore: messagesResult.hasMore,
    state: stateWithRecovery,
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
  const before = getMessageCursor('before', c.req.query('before'));
  const after = getMessageCursor('after', c.req.query('after'));
  const roles = getRequestedRoles(c.req.query('roles') ?? c.req.query('role'));
  const order = getMessageOrder(c.req.query('order'), { before, after });

  const compactDefault = (c.env.CHAT_COMPACT_MODE_DEFAULT ?? '').toLowerCase();
  const defaultCompact = compactDefault === 'false' ? false : DEFAULT_CHAT_COMPACT_MODE;
  const compact = getCompactMode(c.req.query('compact'), defaultCompact);

  const messagesResult = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    limit,
    before,
    after,
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

  const toolContent = await projectDataService.getMessageToolContent(
    c.env,
    projectId,
    sessionId,
    messageId
  );

  if (toolContent === null) {
    throw errors.notFound('Message tool content');
  }

  return c.json(toolContent);
});

chatRoutes.route('/', chatCommentRoutes);

registerChatStopRoute(chatRoutes);
registerChatCancelRoute(chatRoutes);

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
 * GET /api/projects/:projectId/sessions/:sessionId/durability
 * Project-scoped debug snapshot for durable prompt/checkpoint state.
 */
chatRoutes.get('/:sessionId/durability', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:read');
  await requireSessionCreator(c.env, projectId, sessionId, userId);

  const snapshot = await projectDataService.getDurableExecutionSnapshot(
    c.env,
    projectId,
    sessionId
  );
  return c.json(snapshot);
});

registerChatPromptRoute(chatRoutes);
registerChatCommentDirectiveRoute(chatRoutes);

/**
 * POST /api/projects/:projectId/sessions/:sessionId/attention/:markerId/resolve
 * Validate, deliver, and record one of the agent-provided answer options.
 */
chatRoutes.post('/:sessionId/attention/:markerId/resolve', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const markerId = requireRouteParam(c, 'markerId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  await requireSessionCreator(c.env, projectId, sessionId, userId);

  const { answer } = await parseOptionalBody(c.req.raw, ResolveAttentionAnswerSchema, {
    answer: '',
  });
  if (!answer) throw errors.badRequest('answer is required');

  const prepared = await projectDataService.prepareAttentionAnswer(
    c.env,
    projectId,
    sessionId,
    markerId,
    answer
  );
  if (prepared.status === 'not_found') throw errors.notFound('Attention request');
  if (prepared.status === 'invalid_option') {
    throw errors.badRequest('answer must match one of the requested options');
  }
  if (prepared.status === 'already_resolved') {
    if (prepared.answer !== answer) throw errors.conflict('Attention request is already resolved');
    return c.json({ resolved: true, alreadyResolved: true, answer });
  }
  if (prepared.status === 'conflicting_answer') {
    throw errors.conflict('A different answer is already being delivered');
  }
  if (prepared.status === 'in_flight') {
    return c.json({ resolved: false, alreadyResolved: false, inFlight: true, answer }, 202);
  }

  let preparedPrompt;
  try {
    preparedPrompt = await preparePromptForLiveAgent(c.env, db, {
      projectId,
      sessionId,
      userId,
      content: answer,
    });
  } catch (cause) {
    // Resolution/enrichment failed before the mutating request began, so this
    // claim is definitively safe to retry.
    await projectDataService.releaseAttentionAnswer(c.env, projectId, sessionId, markerId, answer);
    throw cause;
  }

  // Every transport/response error after this boundary is outcome-unknown: the
  // VM agent dispatches asynchronously before responding. Preserve the claim so
  // an approval is never replayed. The marker ID is also propagated as the
  // stable downstream message ID for persistence-level deduplication.
  await sendPreparedPromptToLiveAgent(c.env, preparedPrompt, markerId);
  await projectDataService.completeAttentionAnswer(c.env, projectId, sessionId, markerId, answer);
  return c.json({ resolved: true, alreadyResolved: false, answer });
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
