/**
 * Chat session routes — CRUD for project chat sessions and messages.
 *
 * All routes are scoped under /api/projects/:projectId/sessions.
 * Authentication is required for all routes.
 *
 * See: specs/018-project-first-architecture/tasks.md (T027)
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { CreateChatSessionSchema, parseOptionalBody } from '../schemas';
import * as chatPersistence from '../services/chat-persistence';
import * as projectDataService from '../services/project-data';
import { requireSessionWriter } from '../services/session-access';
import { registerChatAcpInteractionRoutes } from './chat-acp-interactions';
import { registerChatAttentionRoute } from './chat-attention';
import { registerChatCancelRoute } from './chat-cancel';
import { chatCommentRoutes } from './chat-comments';
import { chatIdeaRoutes } from './chat-ideas';
import {
  getCompactMode,
  getDefaultCompactMode,
  getMessageCursor,
  getMessageOrder,
  getRequestedRoles,
  getSessionMessageLimit,
} from './chat-message-query';
import { registerChatPromptRoute } from './chat-prompt-route';
import { registerChatSessionAccessRoutes } from './chat-session-access';
import { registerChatSessionControlRoutes } from './chat-session-controls';
import { registerChatSessionDetailRoute } from './chat-session-detail';
import { registerChatSessionListRoute } from './chat-session-list';
import { chatStateRoutes } from './chat-state';
import { registerChatStopRoute } from './chat-stop';
import { registerChatAgentCredentialRoute } from './chat-agent-credential';
import { registerChatWorkloadIdentityRoute } from './chat-workload-identity';

const chatRoutes = new Hono<{ Bindings: Env }>();

chatRoutes.use('/*', requireAuth(), requireApproved());

registerChatSessionListRoute(chatRoutes);
registerChatWorkloadIdentityRoute(chatRoutes);
registerChatAgentCredentialRoute(chatRoutes);
registerChatAcpInteractionRoutes(chatRoutes);

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

registerChatSessionDetailRoute(chatRoutes);

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

  const compact = getCompactMode(c.req.query('compact'), getDefaultCompactMode(c.env));

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
registerChatSessionControlRoutes(chatRoutes);
registerChatSessionAccessRoutes(chatRoutes);

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
  await requireSessionWriter(c.env, projectId, sessionId, userId, {
    db,
    action: 'keep this session awake',
  });

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
  await requireSessionWriter(c.env, projectId, sessionId, userId, {
    db,
    action: 'inspect delivery state for this session',
  });

  const snapshot = await projectDataService.getDurableExecutionSnapshot(
    c.env,
    projectId,
    sessionId
  );
  return c.json(snapshot);
});

registerChatPromptRoute(chatRoutes);

registerChatAttentionRoute(chatRoutes);

chatRoutes.route('/', chatIdeaRoutes);

// Browser-side POST /:sessionId/messages route removed — messages are now
// persisted exclusively by the VM agent via POST /api/workspaces/:id/messages.
// See: specs/021-task-chat-architecture (US1 — Agent-Side Chat Persistence).

export { chatRoutes };
