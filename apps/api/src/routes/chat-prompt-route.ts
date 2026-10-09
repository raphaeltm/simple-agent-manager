import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { requireProjectCapability } from '../middleware/project-auth';
import { parseOptionalBody, SendChatMessageSchema } from '../schemas';
import { cliOperationReceipt } from '../services/cli-operation-receipts';
import { sendChat } from '../services/send-chat';
import { requireSessionCreator } from './chat-session-ownership';

/** Register follow-up prompt delivery, including the durable opt-in path. */
export function registerChatPromptRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.post(
    '/:sessionId/prompt',
    async (c, next) => {
      const projectId = requireRouteParam(c, 'projectId');
      const sessionId = requireRouteParam(c, 'sessionId');
      const userId = getUserId(c);
      await requireProjectCapability(
        drizzle(c.env.DATABASE, { schema }),
        projectId,
        userId,
        'task:write'
      );
      await requireSessionCreator(c.env, projectId, sessionId, userId);
      return cliOperationReceipt(c, next);
    },
    async (c) => {
      const body = await parseOptionalBody(c.req.raw, SendChatMessageSchema, {});
      const result = await sendChat(
        c.env,
        getUserId(c),
        requireRouteParam(c, 'projectId'),
        requireRouteParam(c, 'sessionId'),
        body
      );
      return c.json(result, 'accepted' in result ? 202 : 200);
    }
  );
}
