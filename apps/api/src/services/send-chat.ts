import { drizzle } from 'drizzle-orm/d1';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import type { Env } from '../env';
import { expectJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { forwardPromptToLiveAgent } from '../routes/chat-prompt-forward';
import { requireSessionCreator } from '../routes/chat-session-ownership';
import { type SendChatMessageSchema } from '../schemas';
import { enrichMessageWithMentions } from '../services/mention-enrichment';
import * as projectDataService from '../services/project-data';
import { cancelScheduledSessionSleep } from '../services/session-snapshots';

export function validateSendChatContent(body: v.InferOutput<typeof SendChatMessageSchema>): string {
  const content = body.content?.trim();
  if (!content) throw errors.badRequest('content is required');
  return content;
}

export async function sendChat(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  body: v.InferOutput<typeof SendChatMessageSchema>
) {
  const db = drizzle(env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  await requireSessionCreator(env, projectId, sessionId, userId);

  const content = validateSendChatContent(body);

  const { enrichedMessage } = await enrichMessageWithMentions(content, db, projectId, userId, env);
  // A follow-up is an immediate keep-awake gesture. Cancel only an unclaimed
  // idle sleep; durable delivery wakes a sleep that has already begun.
  await cancelScheduledSessionSleep(db, sessionId);
  const durableConfig = resolveDurableExecutionConfig(env);
  if (durableConfig.deliveryEnabled) {
    const accepted = await projectDataService.acceptPromptDelivery(env, projectId, {
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
    return {
      accepted: true,
      status: 'queued',
      deliveryId: accepted.message.id,
      messageId: accepted.transcriptMessageId,
    };
  }

  const result = await forwardPromptToLiveAgent(env, db, {
    projectId,
    sessionId,
    userId,
    content,
    enrichedMessage,
  });
  return expectJsonRecord(result, 'chat.agent_prompt_result');
}
