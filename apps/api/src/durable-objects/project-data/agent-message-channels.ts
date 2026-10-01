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
  PROJECT_EVENT_CHANNEL_TYPE,
  type SendAgentChannelMessageInput,
  type SendAgentChannelMessageResult,
} from '@simple-agent-manager/shared';

import {
  AGENT_MESSAGE_SUBSCRIPTION_KEY_PREFIX,
  agentMessageChannelName,
} from './agent-message-notice';
import { channelLimits } from './project-event-channels-config';
import {
  channelDeliveryKey,
  normalizeChannelActor,
  type PreparedChannelPublish,
  publishChannel,
} from './project-event-channels-publish';
import { channelDto, readChannel } from './project-event-channels-storage';
import { createProjectEventSubscription } from './project-events';
import {
  ProjectEventIdempotencyConflictError,
  ProjectEventValidationError,
} from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { assertProjectBinding, normalizeProjectId } from './project-events-normalization';
import { expireSubscriptionIds, readEventByDeliveryKey } from './project-events-storage-helpers';
import { normalizeText, sha256Hex, stableStringify } from './project-events-values';
import { type Env, generateId } from './types';

const MANAGED_OWNER_NAME = 'SAM agent messaging';
const CHANNEL_MESSAGE_CLASSES = new Set(['notify', 'deliver']);
const ROTATION_REASON = 'agent message subscription renewed';

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
  const channel = await agentMessageChannelName(
    projectId,
    actor.chatSessionId,
    recipient.chatSessionId
  );
  return {
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

  const rotatedSubscriptionIds: string[] = [];
  const recipientSubscriptionId = ensureManagedSubscription(
    sql,
    env,
    prepared.projectId,
    prepared.recipient,
    prepared.channel,
    prepared.actor.taskId,
    now,
    rotatedSubscriptionIds
  );
  const senderSubscriptionId = ensureManagedSubscription(
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
    now,
    rotatedSubscriptionIds
  );
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
    senderSubscriptionId,
    rotatedSubscriptionIds,
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
  if (!row) throw new ProjectEventValidationError('The recipient chat is not active for its task');
}

type ManagedSubscriptionRow = {
  id: string;
  expires_at: number | null;
  delivery_lifetime_expires_at: number | null;
  prompt_delivery_count: number;
};

/**
 * Reuse the participant's managed subscription for this channel while it can
 * still wake the chat; otherwise retire it and create a fresh one. At most one
 * managed subscription per (chat, channel) stays active. Ownership mirrors an
 * agent's own subscriptions (`${projectId}:${chatSessionId}`), so the canonical
 * list/get/ack tools serve it, and `ownerTaskId` is the participant's stable
 * source task, which the wake path re-checks before every delivery.
 */
function ensureManagedSubscription(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  participant: AgentChannelMessageParticipant,
  channel: string,
  peerTaskId: string,
  now: number,
  rotated: string[]
): string {
  const limits = resolveProjectEventLimits(env);
  const graceMs = channelLimits(env).agentMessageRotationGraceMs;
  const ownerId = `${projectId}:${participant.chatSessionId}`;
  const keyPrefix = `${AGENT_MESSAGE_SUBSCRIPTION_KEY_PREFIX}${channel}:`;
  const rows = sql
    .exec<ManagedSubscriptionRow>(
      `SELECT id, expires_at, delivery_lifetime_expires_at, prompt_delivery_count
       FROM project_event_subscriptions
       WHERE project_id = ? AND owner_type = 'agent' AND owner_id = ? AND target_session_id = ?
         AND lifecycle_state = 'active' AND substr(idempotency_key, 1, ?) = ?
       ORDER BY created_at DESC, id DESC`,
      projectId,
      ownerId,
      participant.chatSessionId,
      keyPrefix.length,
      keyPrefix
    )
    .toArray();
  let reusable: string | null = null;
  const retire: string[] = [];
  for (const row of rows) {
    const end = Math.min(
      row.expires_at ?? Number.POSITIVE_INFINITY,
      row.delivery_lifetime_expires_at ?? Number.POSITIVE_INFINITY
    );
    const canWake = row.prompt_delivery_count < limits.wakeMaxPerSubscription && end > now;
    // Near its end, keep it only while it still owes a wake: retiring would fail it.
    if (
      reusable === null &&
      canWake &&
      (end > now + graceMs || hasPendingWake(sql, projectId, row.id))
    ) {
      reusable = row.id;
    } else {
      retire.push(row.id);
    }
  }
  if (retire.length > 0) {
    for (const id of retire) {
      sql.exec(
        `UPDATE project_event_subscriptions SET expires_at = ?
         WHERE project_id = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        now,
        projectId,
        id,
        now
      );
    }
    expireSubscriptionIds(sql, projectId, retire, now, ROTATION_REASON);
    rotated.push(...retire);
  }
  if (reusable) return reusable;
  return createProjectEventSubscription(sql, env, projectId, {
    projectId,
    owner: { type: 'agent', id: ownerId, name: MANAGED_OWNER_NAME },
    idempotencyKey: `${keyPrefix}${generateId()}`,
    filter: {
      version: 1,
      source: PROJECT_EVENT_CHANNEL_SOURCE,
      eventType: PROJECT_EVENT_CHANNEL_TYPE,
      subjectType: 'agent_channel',
      subjectId: channel,
    },
    deliveryPreference: {
      requested: 'existing_session_prompt',
      resolved: 'queued_for_prompt_delivery',
      // Stable chat identity only: runtime/agent IDs change across sleep/wake.
      target: {
        sessionId: participant.chatSessionId,
        taskId: participant.taskId,
        runtimeId: null,
        agentId: null,
      },
    },
    ownerTaskId: participant.sourceTaskId,
    reason: `SAM agent messaging on ${channel} with task ${peerTaskId}`,
    expiresAt: now + limits.wakeSubscriptionLifetimeMs,
  }).subscription.id;
}

function hasPendingWake(sql: SqlStorage, projectId: string, subscriptionId: string): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM project_event_matches
         WHERE project_id = ? AND subscription_id = ? AND state = 'matched' AND batch_id IS NULL
         UNION ALL
         SELECT 1 FROM project_event_delivery_batches
         WHERE project_id = ? AND subscription_id = ? AND delivery_channel = 'prompt_queue'
           AND state = 'pending'
         LIMIT 1`,
        projectId,
        subscriptionId,
        projectId,
        subscriptionId
      )
      .toArray().length > 0
  );
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
    rotatedSubscriptionIds: [],
  };
}
