import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { parseOptionalBody, SendChatMessageSchema } from '../schemas';
import { enrichMessageWithMentions } from '../services/mention-enrichment';
import * as projectDataService from '../services/project-data';
import { cancelScheduledSessionSleep } from '../services/session-snapshots';
import { forwardPromptToLiveAgent } from './chat-prompt-forward';
import { requireSessionCreator } from './chat-session-ownership';

/** Register follow-up prompt delivery, including the durable opt-in path. */
export function registerChatPromptRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.post('/:sessionId/prompt', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await requireSessionCreator(c.env, projectId, sessionId, userId);

    const body = await parseOptionalBody(c.req.raw, SendChatMessageSchema, {});
    const content = body.content?.trim();
    if (!content) throw errors.badRequest('content is required');

    const { enrichedMessage } = await enrichMessageWithMentions(
      content,
      db,
      projectId,
      userId,
      c.env
    );
    // A follow-up is an immediate keep-awake gesture. Cancel only an unclaimed
    // idle sleep; durable delivery wakes a sleep that has already begun.
    await cancelScheduledSessionSleep(db, sessionId);
    const durableConfig = resolveDurableExecutionConfig(c.env);
    if (durableConfig.deliveryEnabled) {
      const accepted = await projectDataService.acceptPromptDelivery(c.env, projectId, {
        targetSessionId: sessionId,
        displayContent: content,
        deliveryContent: enrichedMessage,
        senderType: 'human',
        senderId: userId,
        messageClass: 'deliver',
        sourceKind: 'user_followup',
        ttlMs: durableConfig.ttlMs,
        metadata: { userId },
      });
      return c.json(
        {
          accepted: true,
          status: 'queued',
          deliveryId: accepted.message.id,
          messageId: accepted.transcriptMessageId,
        },
        202
      );
    }

    const result = await forwardPromptToLiveAgent(c.env, db, {
      projectId,
      sessionId,
      userId,
      content,
      enrichedMessage,
    });
    return c.json(expectJsonRecord(result, 'chat.agent_prompt_result'));
  });
}
