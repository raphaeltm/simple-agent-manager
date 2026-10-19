import type { Hono } from 'hono';

import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { parseOptionalBody, SendChatMessageSchema } from '../schemas';
import { cliOperationReceipt } from '../services/cli-operation-receipts';
import { type AuthorizedSendChat, authorizeSendChat, sendChat } from '../services/send-chat';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set by the prompt route's authorization step; consumed by its handler. */
    sendChatAuthorization: AuthorizedSendChat;
  }
}

/** Register follow-up prompt delivery, including the durable opt-in path. */
export function registerChatPromptRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.post(
    '/:sessionId/prompt',
    async (c, next) => {
      // Authorize before an idempotency receipt is reserved, then hand the result to the
      // handler so the session-writer and repository checks run once per request.
      c.set(
        'sendChatAuthorization',
        await authorizeSendChat(
          c.env,
          getUserId(c),
          requireRouteParam(c, 'projectId'),
          requireRouteParam(c, 'sessionId')
        )
      );
      return cliOperationReceipt(c, next);
    },
    async (c) => {
      const authorized = c.get('sendChatAuthorization');
      if (!authorized) throw errors.internal('Prompt authorization did not run');
      const body = await parseOptionalBody(c.req.raw, SendChatMessageSchema, {});
      const result = await sendChat(
        c.env,
        getUserId(c),
        requireRouteParam(c, 'projectId'),
        requireRouteParam(c, 'sessionId'),
        body,
        authorized
      );
      return c.json(result, 'accepted' in result ? 202 : 200);
    }
  );
}
