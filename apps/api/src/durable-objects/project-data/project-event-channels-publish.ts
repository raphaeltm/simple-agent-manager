import {
  type AdmitProjectEventInput,
  AGENT_MESSAGE_CHANNEL_PREFIX,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
  type ProjectEventChannelActor,
  type ProjectEventJsonValue,
  type PublishProjectEventChannelInput,
  type PublishProjectEventChannelResult,
} from '@simple-agent-manager/shared';

import { isAgentMessageChannelName } from './agent-message-notice';
import { channelLimits, channelName } from './project-event-channels-config';
import { channelDto, readChannel } from './project-event-channels-storage';
import { admitProjectEvent } from './project-events';
import {
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { assertProjectBinding, normalizeProjectId } from './project-events-normalization';
import { readEventByDeliveryKey } from './project-events-storage-helpers';
import {
  normalizeNullableText,
  normalizeText,
  sha256Hex,
  stableStringify,
} from './project-events-values';
import { type Env, generateId } from './types';

export type NormalizedChannelActor = {
  userId: string;
  taskId: string;
  chatSessionId: string;
  workspaceId: string;
  agentSessionId: string | null;
};

export function normalizeChannelActor(
  actor: ProjectEventChannelActor,
  maxBytes: number
): NormalizedChannelActor {
  return {
    userId: normalizeText(actor.userId, 'actor.userId', maxBytes),
    taskId: normalizeText(actor.taskId, 'actor.taskId', maxBytes),
    chatSessionId: normalizeText(actor.chatSessionId, 'actor.chatSessionId', maxBytes),
    workspaceId: normalizeText(actor.workspaceId, 'actor.workspaceId', maxBytes),
    agentSessionId: normalizeNullableText(
      actor.agentSessionId ?? null,
      'actor.agentSessionId',
      maxBytes
    ),
  };
}

/**
 * Stable same-chat replay survives a runtime/task recovery. The first committed
 * event retains its original task/workspace provenance.
 */
export function channelDeliveryKey(
  projectId: string,
  actor: NormalizedChannelActor,
  channel: string,
  idempotencyKey: string
): Promise<string> {
  return sha256Hex(
    stableStringify([projectId, actor.userId, actor.chatSessionId, channel, idempotencyKey])
  );
}

/** Normalize and capture all fields before the asynchronous hash boundary. */
export async function prepareChannelPublish(
  env: Env,
  input: PublishProjectEventChannelInput
): Promise<PreparedChannelPublish> {
  const limits = resolveProjectEventLimits(env);
  const channel = channelName(input.channel, env);
  if (isAgentMessageChannelName(channel)) {
    throw new ProjectEventValidationError(
      `Channel names starting with ${AGENT_MESSAGE_CHANNEL_PREFIX} are reserved for SAM agent messaging; use send_durable_message`
    );
  }
  const projectId = normalizeProjectId(input.projectId, limits);
  const message = normalizeText(input.message, 'message', channelLimits(env).messageBytes);
  const key = normalizeText(input.idempotencyKey, 'idempotencyKey', limits.maxFilterStringBytes);
  const actor = normalizeChannelActor(input.actor, limits.maxFilterStringBytes);
  const deliveryKey = await channelDeliveryKey(projectId, actor, channel, key);
  const payloadFingerprint = await sha256Hex(
    stableStringify([actor.userId, actor.chatSessionId, channel, message])
  );
  return { channel, projectId, message, actor, deliveryKey, payloadFingerprint };
}

export type PreparedChannelPublish = {
  channel: string;
  projectId: string;
  message: string;
  actor: NormalizedChannelActor;
  deliveryKey: string;
  payloadFingerprint: string;
  /** Server-derived extras; the canonical message/actor/channel keys always win. */
  extraMetadata?: Record<string, ProjectEventJsonValue>;
  displayTitle?: string;
};

/** Agent-message pair channels and all other channels have separate catalog caps. */
function namespaceChannelCount(
  sql: SqlStorage,
  projectId: string,
  agentMessage: boolean,
  cap: number
): number {
  // Prefix range over the (project_id, name) unique index: '/' sorts right after '.'.
  const range = `name >= ? AND name < ?`;
  return sql
    .exec(
      `SELECT id FROM project_event_channels WHERE project_id = ? AND ${agentMessage ? '' : 'NOT '}(${range}) LIMIT ?`,
      projectId,
      AGENT_MESSAGE_CHANNEL_PREFIX,
      `${AGENT_MESSAGE_CHANNEL_PREFIX.slice(0, -1)}/`,
      cap
    )
    .toArray().length;
}

/** Must execute in one storage transaction, including canonical strict fanout. */
export function publishChannel(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: PreparedChannelPublish
): PublishProjectEventChannelResult {
  assertProjectBinding(storedProjectId, input.projectId);
  const now = Date.now();
  const limits = channelLimits(env);
  let channel = readChannel(sql, input.projectId, input.channel);
  const existing = readEventByDeliveryKey(
    sql,
    input.projectId,
    PROJECT_EVENT_CHANNEL_SOURCE,
    input.deliveryKey
  );
  // Replays/conflicts resolve before capacity checks. Idempotency lasts while the
  // canonical event is retained; no indefinite secondary receipt store exists.
  if (!existing) {
    const rate = sql
      .exec<{
        window_started_at: number;
        publish_count: number;
      }>('SELECT * FROM project_event_channel_publish_rate WHERE project_id = ?', input.projectId)
      .toArray()[0];
    const sameWindow = rate && now < rate.window_started_at + limits.publishWindowMs;
    if (sameWindow && rate.publish_count >= limits.publishMax) {
      throw new ProjectEventLimitExceededError('Project channel publish rate exceeded');
    }
    if (!channel) {
      const agentMessage = isAgentMessageChannelName(input.channel);
      const cap = agentMessage ? limits.agentMessageMaxChannels : limits.maxChannels;
      if (namespaceChannelCount(sql, input.projectId, agentMessage, cap) >= cap)
        throw new ProjectEventLimitExceededError(
          agentMessage
            ? 'Project agent message channel capacity exceeded'
            : 'Project channel capacity exceeded'
        );
      const id = generateId();
      sql.exec(
        `INSERT INTO project_event_channels (id, project_id, name, last_published_at) VALUES (?, ?, ?, ?)`,
        id,
        input.projectId,
        input.channel,
        now
      );
      channel = readChannel(sql, input.projectId, input.channel);
    }
    sql.exec(
      `INSERT INTO project_event_channel_publish_rate (project_id, window_started_at, publish_count)
      VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET
      window_started_at = excluded.window_started_at, publish_count = excluded.publish_count`,
      input.projectId,
      sameWindow ? rate.window_started_at : now,
      sameWindow ? rate.publish_count + 1 : 1
    );
  }
  if (!channel)
    throw new ProjectEventValidationError(
      'Channel catalog is inconsistent with its retained event'
    );
  const envelope: AdmitProjectEventInput = {
    projectId: input.projectId,
    source: PROJECT_EVENT_CHANNEL_SOURCE,
    eventType: PROJECT_EVENT_CHANNEL_TYPE,
    subject: { type: 'agent_channel', id: channel.name },
    deliveryKey: input.deliveryKey,
    payloadFingerprint: input.payloadFingerprint,
    metadata: {
      ...input.extraMetadata,
      message: input.message,
      actor: input.actor,
      channel: input.channel,
    },
    display: { title: input.displayTitle ?? 'Agent channel message' },
    occurredAt: now,
    receivedAt: now,
  };
  const result = admitProjectEvent(sql, env, storedProjectId, envelope, true);
  if (result.outcome === 'created') {
    const sequence = channel.lifetime_count + 1;
    if (!Number.isSafeInteger(sequence))
      throw new ProjectEventLimitExceededError('Channel sequence capacity exceeded');
    sql.exec(
      'UPDATE project_events SET channel_id = ?, channel_sequence = ? WHERE id = ?',
      channel.id,
      sequence,
      result.event.id
    );
    sql.exec(
      `UPDATE project_event_channels SET lifetime_count = ?,
      last_published_at = ? WHERE id = ?`,
      sequence,
      now,
      channel.id
    );
    channel = { ...channel, lifetime_count: sequence, last_published_at: now };
  }
  const position = sql
    .exec<{
      channel_sequence: number;
    }>('SELECT channel_sequence FROM project_events WHERE id = ?', result.event.id)
    .one();
  return { ...result, channel: channelDto(channel), sequence: position.channel_sequence };
}
