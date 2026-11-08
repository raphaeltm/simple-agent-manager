import { drizzle } from 'drizzle-orm/d1';
import type * as v from 'valibot';

import * as schema from '../db/schema';
import { resolveDurableExecutionConfig } from '../durable-objects/project-data/durable-execution-config';
import type { Env } from '../env';
import { type AgentWakeGrant, agentWakeRecord } from '../lib/agent-wake-policy';
import { expectJsonRecord } from '../lib/runtime-validation';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { forwardPromptToLiveAgent } from '../routes/chat-prompt-forward';
import { getMcpLimits } from '../routes/mcp/_helpers';
import { type SendChatMessageSchema } from '../schemas';
import { enrichMessageWithMentions } from '../services/mention-enrichment';
import * as projectDataService from '../services/project-data';
import { cancelScheduledSessionSleep } from '../services/session-snapshots';
import { buildVisibleInitialPrompt } from './agent-bootstrap-prompt';
import { authorizeAgentWake } from './agent-wake-authorization';
import { validateAttachments } from './attachment-upload';
import type { SessionWriterContext } from './session-access';
import { buildSharedSessionSpeakerLine, loadSharedSessionNames } from './shared-session-names';

export function validateSendChatContent(body: v.InferOutput<typeof SendChatMessageSchema>): string {
  const content = body.content?.trim();
  if (!content) throw errors.badRequest('content is required');
  return content;
}

export interface AuthorizedSendChat {
  project: schema.Project;
  writer: SessionWriterContext;
  /** The agent-wake policy's grant for this prompt; recorded on the delivery. */
  wake: AgentWakeGrant;
}

/**
 * The full authorization for a prompt: project capability and the agent-wake policy
 * (`authorizeAgentWake`: a session writer, i.e. the owner, or a grantee while both people stay
 * active project members). Routes call it before an idempotency
 * receipt is reserved and hand the result to `sendChat`, so the checks run once per request.
 */
export async function authorizeSendChat(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string
): Promise<AuthorizedSendChat> {
  const db = drizzle(env.DATABASE, { schema });
  const project = await requireProjectCapability(db, projectId, userId, 'task:write');
  const { writer, wake } = await authorizeAgentWake(env, {
    projectId,
    sessionId,
    actorUserId: userId,
    trigger: 'user_followup',
    db,
    action: 'send messages in this session',
  });
  return { project, writer, wake };
}

function matchesRequest(
  authorized: AuthorizedSendChat | undefined,
  userId: string,
  projectId: string,
  sessionId: string
): authorized is AuthorizedSendChat {
  return (
    authorized !== undefined &&
    authorized.writer.actorUserId === userId &&
    authorized.writer.projectId === projectId &&
    authorized.writer.sessionId === sessionId
  );
}

export async function sendChat(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  body: v.InferOutput<typeof SendChatMessageSchema>,
  authorized?: AuthorizedSendChat,
  assertEffectAllowed?: () => Promise<void>
) {
  const db = drizzle(env.DATABASE, { schema });

  const { writer, wake } = matchesRequest(authorized, userId, projectId, sessionId)
    ? authorized
    : await authorizeSendChat(env, userId, projectId, sessionId);
  const shared = writer.role === 'grantee';

  const content = validateSendChatContent(body);
  const deliveryIntent = body.deliveryIntent ?? 'queue';

  // Every refusal comes before the first side effect (validating uploads, cancelling a
  // scheduled sleep), so a refused prompt changes nothing.
  const durableConfig = resolveDurableExecutionConfig(env);
  if (assertEffectAllowed && !durableConfig.deliveryEnabled)
    throw errors.conflict('SAM follow-ups require durable prompt delivery');
  const attachments = body.attachments ?? [];
  if (shared && !durableConfig.deliveryEnabled) {
    // Durable delivery is what carries sender attribution and lets revocation cancel a queued
    // prompt; the live fallback has neither.
    throw errors.conflict('Shared session messages require durable prompt delivery');
  }
  if (attachments.length > 0 && !durableConfig.deliveryEnabled) {
    throw errors.badRequest('Attachment messages require durable prompt delivery to be enabled');
  }
  if (deliveryIntent === 'steer' && !durableConfig.deliveryEnabled) {
    throw errors.conflict('Steering requires durable prompt delivery');
  }
  if (deliveryIntent === 'steer' && attachments.length > 0) {
    // A steer carries text into the running turn; files travel with a queued prompt.
    throw errors.badRequest('Attachments cannot be sent as a steer; queue the message instead');
  }
  // The same bound as an agent's steer through send_durable_message (MAILBOX_MESSAGE_MAX_LENGTH).
  if (deliveryIntent === 'steer' && content.length > getMcpLimits(env).mailboxMessageMaxLength) {
    throw errors.badRequest('Message is too long to steer; queue it instead');
  }
  if (attachments.length > 0) {
    const validation = await validateAttachments(env, userId, attachments);
    if (!validation.valid) throw errors.badRequest(validation.errors.join('; '));
  }
  // Agent-profile @mentions resolve as the session owner: the agent dispatches with the
  // owner's identity, so only profiles the owner can use are meaningful hints.
  const { enrichedMessage } = await enrichMessageWithMentions(
    content,
    db,
    projectId,
    writer.ownerUserId,
    env
  );
  // A follow-up is an immediate keep-awake gesture. Cancel only an unclaimed
  // idle sleep; durable delivery wakes a sleep that has already begun.
  await assertEffectAllowed?.();
  await cancelScheduledSessionSleep(db, sessionId);
  if (durableConfig.deliveryEnabled) {
    const names = shared
      ? await loadSharedSessionNames(env.DATABASE, writer.actorUserId, writer.ownerUserId)
      : null;
    const deliveryMessage = names
      ? `${buildSharedSessionSpeakerLine(names)}\n\n${enrichedMessage}`
      : enrichedMessage;
    await assertEffectAllowed?.();
    const accepted = await projectDataService.acceptPromptDelivery(env, projectId, {
      targetSessionId: sessionId,
      displayContent: buildVisibleInitialPrompt({ message: content, attachments }),
      deliveryContent: buildVisibleInitialPrompt({ message: deliveryMessage, attachments }),
      senderType: 'human',
      senderId: userId,
      messageClass: 'deliver',
      deliveryIntent,
      sourceKind: 'user_followup',
      ttlMs: durableConfig.ttlMs,
      metadata: {
        userId,
        wake: agentWakeRecord(wake),
        ...(names
          ? {
              senderName: names.senderName,
              onBehalfOfUserId: writer.ownerUserId,
              grantId: writer.grantId,
            }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    });
    return {
      accepted: true,
      status: 'queued',
      deliveryIntent,
      deliveryId: accepted.message.id,
      messageId: accepted.transcriptMessageId,
    };
  }

  const result = await forwardPromptToLiveAgent(env, db, {
    projectId,
    sessionId,
    userId: writer.ownerUserId,
    content,
    enrichedMessage,
  });
  return expectJsonRecord(result, 'chat.agent_prompt_result');
}
