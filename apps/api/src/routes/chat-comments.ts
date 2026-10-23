import type {
  CommentStatus,
  MessageCommentContextResponse,
  MessageCommentThread,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  getCommentActor,
  parseCommentStatus,
  parseNonNegativeIntegerQuery,
  parsePositiveIntegerQuery,
  rethrowCommentError,
} from '../lib/comment-http';
import { log } from '../lib/logger';
import { requireRouteParam } from '../lib/route-helpers';
import { resolveWaitUntil } from '../lib/wait-until';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas/_validator';
import {
  CommentStatusMutationSchema,
  CreateCommentReplySchema,
  CreateCommentThreadSchema,
  SendCommentDirectiveSchema,
} from '../schemas/comments';
import { notifyCommentActivity } from '../services/collaboration-notifications';
import { getCommentContextLimits } from '../services/collaboration-settings';
import { resolveCommentMentions } from '../services/comment-mentions';
import {
  createProjectDataMessageCommentAdapter,
  isMessageCommentServiceError,
  sendMessageCommentDirective,
} from '../services/message-comments';
import * as projectDataService from '../services/project-data';
import { requireSessionWriter, toSessionViewerAccess } from '../services/session-access';
import { getDefaultCompactMode } from './chat-message-query';

export const chatCommentRoutes = new Hono<{ Bindings: Env }>();

function rethrowCommentDirectiveError(err: unknown): never {
  if (!isMessageCommentServiceError(err)) {
    throw err;
  }
  switch (err.code) {
    case 'invalid_request':
      throw errors.badRequest(err.message);
    case 'not_found':
      throw errors.notFound('Comment thread');
    case 'forbidden':
      throw errors.forbidden(err.message);
    case 'conflict':
      throw errors.conflict(err.message);
    case 'unavailable':
      throw errors.internal('Comment storage backend is unavailable');
  }
}

/**
 * Notify mentioned people, the session owner and thread participants about a new comment.
 * Runs after the response: the comment is already committed, so a failure here is logged and
 * never turns the write into an error.
 */
function notifyInBackground(
  c: Context<{ Bindings: Env }>,
  input: {
    projectId: string;
    sessionId: string;
    thread: MessageCommentThread;
    comment: { id: string; body: string; mentions: NonNullable<MessageCommentThread['mentions']> };
    kind: 'thread' | 'reply';
  }
): void {
  const actor = getCommentActor(c);
  const work = (async () => {
    const session = await projectDataService.getSession(c.env, input.projectId, input.sessionId);
    await notifyCommentActivity(c.env, {
      projectId: input.projectId,
      sessionId: input.sessionId,
      sessionTopic: typeof session?.topic === 'string' ? session.topic : null,
      sessionOwnerUserId:
        typeof session?.createdByUserId === 'string' ? session.createdByUserId : null,
      thread: input.thread,
      comment: input.comment,
      kind: input.kind,
      actor: { userId: actor.id, name: actor.name },
    });
  })().catch((err) => {
    log.warn('collaboration.comment_notifications_failed', {
      projectId: input.projectId,
      sessionId: input.sessionId,
      threadId: input.thread.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  resolveWaitUntil(c, 'collaboration.comment_notifications_unavailable')(work);
}

/**
 * GET /api/projects/:projectId/sessions/:sessionId/comments
 * List message-anchored comment threads for a chat session.
 */
chatCommentRoutes.get('/:sessionId/comments', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:read');

  try {
    const result = await projectDataService.listCommentThreads(c.env, projectId, {
      sessionId,
      messageId: c.req.query('messageId') ?? null,
      status: parseCommentStatus(c.req.query('status')),
      afterSequence: parseNonNegativeIntegerQuery('afterSequence', c.req.query('afterSequence')),
      limit: parsePositiveIntegerQuery('limit', c.req.query('limit')),
    });
    return c.json(result);
  } catch (err) {
    rethrowCommentError(err);
  }
});

/**
 * GET /api/projects/:projectId/sessions/:sessionId/comments/:threadId/context
 * One thread with the conversation around the message it is anchored to, so the Comments
 * page can show the comment where it was made: the whole anchored message (an agent reply is
 * many streamed rows) plus `collaboration.commentContextMessages` messages each side. Earlier
 * and later pages come from `GET .../messages` with cursors from the first and last rows.
 *
 * Round trips: membership (D1), session access + thread (one ProjectData RPC each, in
 * parallel), the two cached settings, and one RPC to the object that owns the transcript.
 */
chatCommentRoutes.get('/:sessionId/comments/:threadId/context', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const threadId = requireRouteParam(c, 'threadId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:read');

  let loaded: [
    Awaited<ReturnType<typeof projectDataService.getSessionAccess>>,
    MessageCommentThread | null,
  ];
  try {
    loaded = await Promise.all([
      projectDataService.getSessionAccess(c.env, projectId, sessionId, userId),
      projectDataService.getCommentThread(c.env, projectId, sessionId, threadId),
    ]);
  } catch (err) {
    rethrowCommentError(err);
  }
  const [{ session, access }, thread] = loaded;
  if (!session) throw errors.notFound('Chat session');
  // The lookup is already scoped to the session in SQL; refuse a row from another session
  // anyway, so a broken predicate cannot hand one session's thread to another's reader.
  if (!thread || thread.sessionId !== sessionId) {
    if (thread) {
      log.error('comments.context_thread_session_mismatch', {
        projectId,
        threadId,
        requestedSessionId: sessionId,
        threadSessionId: thread.sessionId,
        action: 'rejected',
      });
    }
    throw errors.notFound('Comment thread');
  }

  const limits = await getCommentContextLimits(c.env);
  const window = await projectDataService.getMessageContextWindow(c.env, projectId, sessionId, {
    messageId: thread.anchor.messageId,
    messagesEachSide: limits.messages,
    maxRows: limits.maxRows,
    compact: getDefaultCompactMode(c.env),
  });

  const response: MessageCommentContextResponse = {
    thread,
    session: { id: sessionId, topic: typeof session.topic === 'string' ? session.topic : null },
    viewerAccess: toSessionViewerAccess(access),
    anchor: { messageId: thread.anchor.messageId, found: window.found },
    messages: window.messages,
    hasMoreBefore: window.hasMoreBefore,
    hasMoreAfter: window.hasMoreAfter,
  };
  return c.json(response);
});

/**
 * POST /api/projects/:projectId/sessions/:sessionId/comments
 * Create a message-anchored comment thread. Any project member may comment on any session;
 * a comment never reaches the agent until a session writer sends it (`/send`).
 */
chatCommentRoutes.post(
  '/:sessionId/comments',
  jsonValidator(CreateCommentThreadSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');

    const body = c.req.valid('json');
    const mentions = await resolveCommentMentions(c.env, db, projectId, body.mentions);
    try {
      const result = await projectDataService.createCommentThread(c.env, projectId, {
        sessionId,
        messageId: body.messageId,
        body: body.body,
        quote: body.quote ?? null,
        clientMutationId: body.clientMutationId ?? null,
        actor: getCommentActor(c),
        mentions,
      });
      if (!result.idempotent) {
        notifyInBackground(c, {
          projectId,
          sessionId,
          thread: result.thread,
          comment: {
            id: result.thread.id,
            body: result.thread.body,
            mentions: result.thread.mentions ?? [],
          },
          kind: 'thread',
        });
      }
      return c.json(result, result.idempotent ? 200 : 201);
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);

/**
 * POST /api/projects/:projectId/sessions/:sessionId/comments/:threadId/replies
 * Append a reply to a message-anchored comment thread.
 */
chatCommentRoutes.post(
  '/:sessionId/comments/:threadId/replies',
  jsonValidator(CreateCommentReplySchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const threadId = requireRouteParam(c, 'threadId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');

    const body = c.req.valid('json');
    const mentions = await resolveCommentMentions(c.env, db, projectId, body.mentions);
    try {
      const result = await projectDataService.createCommentReply(c.env, projectId, {
        sessionId,
        threadId,
        body: body.body,
        clientMutationId: body.clientMutationId ?? null,
        actor: getCommentActor(c),
        mentions,
      });
      if (!result.idempotent) {
        notifyInBackground(c, {
          projectId,
          sessionId,
          thread: result.thread,
          comment: {
            id: result.reply.id,
            body: result.reply.body,
            mentions: result.reply.mentions ?? [],
          },
          kind: 'reply',
        });
      }
      return c.json(result, result.idempotent ? 200 : 201);
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);

async function updateCommentStatus(
  c: Context<{ Bindings: Env }>,
  status: CommentStatus,
  clientMutationId: string | null
) {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const threadId = requireRouteParam(c, 'threadId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');

  try {
    return c.json(
      await projectDataService.updateCommentThreadStatus(c.env, projectId, {
        sessionId,
        threadId,
        status,
        clientMutationId,
        actor: getCommentActor(c),
      })
    );
  } catch (err) {
    rethrowCommentError(err);
  }
}

/**
 * POST /api/projects/:projectId/sessions/:sessionId/comments/:threadId/send
 * The explicit "Send to agent" action — the only way a comment reaches the agent. It queues
 * a prompt on the session owner's agent and credentials, so only session writers (the owner
 * or an active grantee) may do it.
 */
chatCommentRoutes.post(
  '/:sessionId/comments/:threadId/send',
  jsonValidator(SendCommentDirectiveSchema),
  async (c) => {
    const body = c.req.valid('json');
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const threadId = requireRouteParam(c, 'threadId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    const writer = await requireSessionWriter(c.env, projectId, sessionId, userId, {
      db,
      action: 'send comments to the agent in this session',
    });

    try {
      const result = await sendMessageCommentDirective({
        env: c.env,
        storage: createProjectDataMessageCommentAdapter(c.env),
        projectId,
        sessionId,
        threadId,
        humanUserId: userId,
        humanDisplayName: getCommentActor(c).name,
        sharedAccess:
          writer.role === 'grantee'
            ? { ownerUserId: writer.ownerUserId, grantId: writer.grantId }
            : null,
        body: body.body ?? null,
      });
      return c.json(
        {
          thread: result.thread,
          comment: result.thread,
          idempotent: result.duplicate,
        },
        result.duplicate ? 200 : 202
      );
    } catch (err) {
      rethrowCommentDirectiveError(err);
    }
  }
);

chatCommentRoutes.post(
  '/:sessionId/comments/:threadId/resolve',
  jsonValidator(CommentStatusMutationSchema),
  (c) => {
    const body = c.req.valid('json');
    return updateCommentStatus(c, 'resolved', body.clientMutationId ?? null);
  }
);

chatCommentRoutes.post(
  '/:sessionId/comments/:threadId/reopen',
  jsonValidator(CommentStatusMutationSchema),
  (c) => {
    const body = c.req.valid('json');
    return updateCommentStatus(c, 'open', body.clientMutationId ?? null);
  }
);
