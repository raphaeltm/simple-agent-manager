/**
 * SAM-managed agent message channels (preview, disabled by default).
 *
 * One canonical `agent-dm.*` channel per unordered pair of stable chat sessions.
 * Both participants hold a SAM-managed prompt-delivery subscription, and a
 * message is published only after both subscriptions exist — all inside one
 * ProjectData storage transaction, so concurrent first sends (A→B and B→A)
 * serialize onto one channel and the first event cannot miss its recipient.
 *
 * This reuses canonical channel storage, matching, wake materialization and
 * read/ack. There is no second message log, wake queue or injection path.
 */
import {
  type AgentChannelMessageParticipant,
  PROJECT_EVENT_CHANNEL_SOURCE,
  type SendAgentChannelMessageInput,
  type SendAgentChannelMessageResult,
} from '@simple-agent-manager/shared';

import { agentMessageChannelName } from './agent-message-notice';
import { ensureManagedSubscription } from './agent-message-subscriptions';
import { channelLimits, channelName } from './project-event-channels-config';
import {
  channelDeliveryKey,
  channelEventMetadata,
  normalizeChannelActor,
  type PreparedChannelPublish,
  publishChannel,
} from './project-event-channels-publish';
import { channelDto, readChannel } from './project-event-channels-storage';
import {
  AgentMessageRecipientUnavailableError,
  ProjectEventIdempotencyConflictError,
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import {
  assertProjectBinding,
  normalizeMetadataWithinBudget,
  normalizeProjectId,
} from './project-events-normalization';
import { readEventByDeliveryKey } from './project-events-storage-helpers';
import { normalizeText, sha256Hex, stableStringify } from './project-events-values';
import type { Env } from './types';

const CHANNEL_MESSAGE_CLASSES = new Set(['notify', 'deliver']);

export type PreparedAgentChannelMessage = PreparedChannelPublish & {
  recipient: AgentChannelMessageParticipant;
  senderSourceTaskId: string;
};

/** Normalize and hash everything before the transaction (hashing is asynchronous). */
export async function prepareAgentChannelMessage(
  env: Env,
  input: SendAgentChannelMessageInput
): Promise<PreparedAgentChannelMessage> {
  const limits = resolveProjectEventLimits(env);
  const maxBytes = limits.maxFilterStringBytes;
  const projectId = normalizeProjectId(input.projectId, limits);
  const actor = normalizeChannelActor(input.actor, maxBytes);
  const recipient = {
    taskId: normalizeText(input.recipient.taskId, 'recipient.taskId', maxBytes),
    sourceTaskId: normalizeText(input.recipient.sourceTaskId, 'recipient.sourceTaskId', maxBytes),
    chatSessionId: normalizeText(
      input.recipient.chatSessionId,
      'recipient.chatSessionId',
      maxBytes
    ),
  };
  if (recipient.chatSessionId === actor.chatSessionId) {
    throw new ProjectEventValidationError('An agent cannot send a message to its own chat session');
  }
  if (!CHANNEL_MESSAGE_CLASSES.has(input.messageClass)) {
    throw new ProjectEventValidationError(
      'Only notify and deliver messages travel over agent message channels'
    );
  }
  const message = normalizeText(input.message, 'message', channelLimits(env).messageBytes);
  const idempotencyKey = normalizeText(input.idempotencyKey, 'idempotencyKey', maxBytes);
  const senderSourceTaskId = normalizeText(
    input.senderSourceTaskId,
    'senderSourceTaskId',
    maxBytes
  );
  const senderMetadata = input.senderMetadata ?? null;
  // Re-validated so a lowered PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES fails closed.
  const channel = channelName(
    await agentMessageChannelName(projectId, actor.chatSessionId, recipient.chatSessionId),
    env
  );
  const prepared: PreparedAgentChannelMessage = {
    channel,
    projectId,
    message,
    actor,
    deliveryKey: await channelDeliveryKey(projectId, actor, channel, idempotencyKey),
    // A retry must repeat the whole intent: same recipient, class and metadata.
    payloadFingerprint: await sha256Hex(
      stableStringify([
        actor.userId,
        actor.chatSessionId,
        channel,
        recipient.chatSessionId,
        input.messageClass,
        message,
        senderMetadata,
      ])
    ),
    // Caller metadata is nested so it can never shadow the server-derived actor.
    extraMetadata: {
      kind: 'agent_message',
      messageClass: input.messageClass,
      recipient: { taskId: recipient.taskId, chatSessionId: recipient.chatSessionId },
      ...(senderMetadata ? { senderMetadata } : {}),
    },
    displayTitle: 'Agent message',
    recipient,
    senderSourceTaskId,
  };
  assertStoredEnvelopeFits(prepared, limits);
  return prepared;
}

/**
 * Check the stored envelope before any write. Oversized or over-deep caller
 * metadata is a payload the caller must fix, not capacity to retry, so it
 * surfaces as a validation error rather than a limit error.
 */
function assertStoredEnvelopeFits(
  prepared: PreparedAgentChannelMessage,
  limits: ReturnType<typeof resolveProjectEventLimits>
): void {
  try {
    normalizeMetadataWithinBudget(channelEventMetadata(prepared), limits);
  } catch (error) {
    if (error instanceof ProjectEventLimitExceededError) {
      throw new ProjectEventValidationError(
        `Agent message is too large to store: ${error.message}`
      );
    }
    throw error;
  }
}

/** Must run inside one storage transaction after the sender's chat was re-verified. */
export function sendAgentChannelMessage(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  prepared: PreparedAgentChannelMessage,
  now = Date.now()
): SendAgentChannelMessageResult {
  assertProjectBinding(storedProjectId, prepared.projectId);
  requireRecipientChat(sql, prepared.recipient);
  const existing = readEventByDeliveryKey(
    sql,
    prepared.projectId,
    PROJECT_EVENT_CHANNEL_SOURCE,
    prepared.deliveryKey
  );
  if (existing) {
    // Reject a changed retry up front: canonical admission would otherwise mark
    // the original message conflicted.
    if (existing.payloadFingerprint !== prepared.payloadFingerprint) {
      throw new ProjectEventIdempotencyConflictError(
        'idempotencyKey was already used for a different agent message'
      );
    }
    return replayResult(sql, prepared, existing.id);
  }

  const recipientSubscription = ensureManagedSubscription(
    sql,
    env,
    prepared.projectId,
    prepared.recipient,
    prepared.channel,
    prepared.actor.taskId,
    now
  );
  const senderSubscription = ensureManagedSubscription(
    sql,
    env,
    prepared.projectId,
    {
      taskId: prepared.actor.taskId,
      sourceTaskId: prepared.senderSourceTaskId,
      chatSessionId: prepared.actor.chatSessionId,
    },
    prepared.channel,
    prepared.recipient.taskId,
    now
  );
  const recipientSubscriptionId = recipientSubscription.id;
  const published = publishChannel(sql, env, storedProjectId, prepared);
  // Accepted must mean "the recipient will be notified": never commit a message
  // its recipient's subscription did not match.
  if (!published.matches.some((match) => match.subscriptionId === recipientSubscriptionId)) {
    throw new ProjectEventValidationError(
      'Agent message was not matched to the recipient subscription'
    );
  }
  return {
    outcome: 'created',
    channel: published.channel,
    eventId: published.event.id,
    sequence: published.sequence,
    recipientSubscriptionId,
    senderSubscriptionId: senderSubscription.id,
    retiredSubscriptionIds: [...recipientSubscription.retired, ...senderSubscription.retired],
  };
}

function requireRecipientChat(sql: SqlStorage, recipient: AgentChannelMessageParticipant): void {
  const row = sql
    .exec(
      `SELECT id FROM chat_sessions WHERE id = ? AND task_id = ?
       AND status IN ('active', 'sleeping') LIMIT 1`,
      recipient.chatSessionId,
      recipient.taskId
    )
    .toArray()[0];
  if (!row) {
    throw new AgentMessageRecipientUnavailableError(
      'Recipient cannot be notified: its chat is no longer active for its task'
    );
  }
}

function replayResult(
  sql: SqlStorage,
  prepared: PreparedAgentChannelMessage,
  eventId: string
): SendAgentChannelMessageResult {
  const channel = readChannel(sql, prepared.projectId, prepared.channel);
  if (!channel) {
    throw new ProjectEventValidationError(
      'Channel catalog is inconsistent with its retained event'
    );
  }
  const position = sql
    .exec<{ channel_sequence: number }>(
      'SELECT channel_sequence FROM project_events WHERE project_id = ? AND id = ?',
      prepared.projectId,
      eventId
    )
    .one();
  const recipientMatch = sql
    .exec<{ subscription_id: string }>(
      `SELECT m.subscription_id FROM project_event_matches m
       JOIN project_event_subscriptions s ON s.project_id = m.project_id AND s.id = m.subscription_id
       WHERE m.project_id = ? AND m.event_id = ? AND s.target_session_id = ?
       ORDER BY m.matched_at ASC, m.id ASC LIMIT 1`,
      prepared.projectId,
      eventId,
      prepared.recipient.chatSessionId
    )
    .toArray()[0];
  return {
    outcome: 'duplicate_replay',
    channel: channelDto(channel),
    eventId,
    sequence: position.channel_sequence,
    recipientSubscriptionId: recipientMatch?.subscription_id ?? null,
    senderSubscriptionId: null,
    retiredSubscriptionIds: [],
  };
}
