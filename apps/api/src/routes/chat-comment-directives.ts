import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { parseOptionalBody, SendCommentDirectiveSchema } from '../schemas';
import {
  createProjectDataMessageCommentAdapter,
  isMessageCommentServiceError,
  sendMessageCommentDirective,
} from '../services/message-comments';
import * as projectDataService from '../services/project-data';

function mapCommentDirectiveError(err: unknown): Error {
  if (!isMessageCommentServiceError(err)) {
    return errors.internal('Failed to send comment directive');
  }
  switch (err.code) {
    case 'invalid_request':
      return errors.badRequest(err.message);
    case 'not_found':
      return errors.notFound('Comment thread');
    case 'forbidden':
      return errors.forbidden(err.message);
    case 'conflict':
      return errors.conflict(err.message);
    case 'unavailable':
      return errors.internal('Comment storage backend is unavailable');
  }
}

/**
 * Register the explicit human "send to agent" action for a message comment.
 *
 * This route only queues a compact durable prompt delivery for one comment
 * thread. It does not inject full comment context into normal session loads.
 */
export function registerChatCommentDirectiveRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.post('/:sessionId/comments/:threadId/send-to-agent', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const threadId = requireRouteParam(c, 'threadId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    const body = await parseOptionalBody(c.req.raw, SendCommentDirectiveSchema, {});

    const session = await projectDataService.getSession(c.env, projectId, sessionId);
    if (!session) {
      throw errors.notFound('Chat session');
    }

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
          accepted: result.accepted,
          status: result.duplicate ? 'duplicate' : 'queued',
          duplicate: result.duplicate,
          deliveryId: result.deliveryId,
          messageId: result.messageId,
          thread: {
            id: result.thread.id,
            status: result.thread.status,
            directive: result.thread.directive,
          },
        },
        202
      );
    } catch (err) {
      throw mapCommentDirectiveError(err);
    }
  });
}
