import type { CommentStatus } from '@simple-agent-manager/shared';
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
import { requireRouteParam } from '../lib/route-helpers';
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
import {
  createProjectDataMessageCommentAdapter,
  isMessageCommentServiceError,
  sendMessageCommentDirective,
} from '../services/message-comments';
import * as projectDataService from '../services/project-data';

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
 * POST /api/projects/:projectId/sessions/:sessionId/comments
 * Create a message-anchored comment thread.
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
    try {
      const result = await projectDataService.createCommentThread(c.env, projectId, {
        sessionId,
        messageId: body.messageId,
        body: body.body,
        quote: body.quote ?? null,
        clientMutationId: body.clientMutationId ?? null,
        actor: getCommentActor(c),
      });
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
    try {
      const result = await projectDataService.createCommentReply(c.env, projectId, {
        sessionId,
        threadId,
        body: body.body,
        clientMutationId: body.clientMutationId ?? null,
        actor: getCommentActor(c),
      });
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

    try {
      const result = await sendMessageCommentDirective({
        env: c.env,
        storage: createProjectDataMessageCommentAdapter(c.env),
        projectId,
        sessionId,
        threadId,
        humanUserId: userId,
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
