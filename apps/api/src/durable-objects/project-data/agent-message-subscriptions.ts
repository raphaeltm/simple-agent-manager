/**
 * SAM-managed prompt-delivery subscriptions for agent-message pair channels:
 * reuse one while it can still wake its chat, retire and replace it when it
 * cannot, and keep all of them inside their share of the project's
 * active-subscription cap. Synchronous by design: callers run it inside the
 * send transaction.
 */
import {
  type AgentChannelMessageParticipant,
  PROJECT_EVENT_CHANNEL_SOURCE,
  PROJECT_EVENT_CHANNEL_TYPE,
} from '@simple-agent-manager/shared';

import { AGENT_MESSAGE_SUBSCRIPTION_KEY_PREFIX } from './agent-message-notice';
import { channelLimits } from './project-event-channels-config';
import { createProjectEventSubscription } from './project-events';
import { ProjectEventLimitExceededError } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { expireSubscriptionIds } from './project-events-storage-helpers';
import { type Env, generateId } from './types';

const MANAGED_OWNER_NAME = 'SAM agent messaging';
const ROTATION_REASON = 'agent message subscription renewed';
const EVICTION_REASON = 'idle agent message subscription released for capacity';

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
export function ensureManagedSubscription(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  participant: AgentChannelMessageParticipant,
  channel: string,
  peerTaskId: string,
  now: number,
  retired: string[]
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
  const stale: string[] = [];
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
      (end > now + graceMs || hasPendingWake(sql, projectId, row.id, participant.chatSessionId))
    ) {
      reusable = row.id;
    } else {
      // Known limit: a subscription out of wakes is retired even if its last wake
      // is still queued, which fails that wake; the messages stay in channel
      // history. Keeping it active instead would also match every new message.
      stale.push(row.id);
    }
  }
  retireManagedSubscriptions(sql, projectId, stale, now, ROTATION_REASON, retired);
  if (reusable) return reusable;
  makeRoomForManagedSubscription(sql, env, projectId, channel, now, retired);
  return createProjectEventSubscription(
    sql,
    env,
    projectId,
    {
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
    },
    { managedAgentMessage: true }
  ).subscription.id;
}

/**
 * Managed subscriptions may hold only `AGENT_MESSAGE_MAX_ACTIVE_SUBSCRIPTIONS` of
 * the project's active-subscription cap, so messaging cannot starve other
 * subscriptions. At the share, release the least recently matched idle managed
 * subscriptions on other channels; their pair's next message recreates them. One
 * that still owes a wake is never released, so a share full of busy pairs fails
 * visibly instead of dropping a notification.
 */
function makeRoomForManagedSubscription(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  channel: string,
  now: number,
  retired: string[]
): void {
  const share = channelLimits(env).agentMessageMaxActiveSubscriptions;
  const prefix = AGENT_MESSAGE_SUBSCRIPTION_KEY_PREFIX;
  const active = sql
    .exec<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM project_event_subscriptions
       WHERE project_id = ? AND lifecycle_state = 'active' AND substr(idempotency_key, 1, ?) = ?`,
      projectId,
      prefix.length,
      prefix
    )
    .one().cnt;
  const needed = active - share + 1;
  if (needed <= 0) return;
  const channelPrefix = `${prefix}${channel}:`;
  const candidates = sql
    .exec<{ id: string; target_session_id: string }>(
      `SELECT id, target_session_id FROM project_event_subscriptions
       WHERE project_id = ? AND lifecycle_state = 'active' AND substr(idempotency_key, 1, ?) = ?
         AND substr(idempotency_key, 1, ?) != ?
       ORDER BY COALESCE(last_matched_at, created_at) ASC, id ASC
       LIMIT ?`,
      projectId,
      prefix.length,
      prefix,
      channelPrefix.length,
      channelPrefix,
      share
    )
    .toArray();
  const victims: string[] = [];
  for (const candidate of candidates) {
    if (victims.length >= needed) break;
    if (!hasPendingWake(sql, projectId, candidate.id, candidate.target_session_id)) {
      victims.push(candidate.id);
    }
  }
  if (victims.length < needed) {
    throw new ProjectEventLimitExceededError(
      'Project agent message subscription capacity exceeded'
    );
  }
  retireManagedSubscriptions(sql, projectId, victims, now, EVICTION_REASON, retired);
}

/** Expire now: delivered batches stay readable until their own read grace ends. */
function retireManagedSubscriptions(
  sql: SqlStorage,
  projectId: string,
  ids: readonly string[],
  now: number,
  reason: string,
  retired: string[]
): void {
  if (ids.length === 0) return;
  for (const id of ids) {
    sql.exec(
      `UPDATE project_event_subscriptions SET expires_at = ?
       WHERE project_id = ? AND id = ? AND (expires_at IS NULL OR expires_at > ?)`,
      now,
      projectId,
      id,
      now
    );
  }
  expireSubscriptionIds(sql, projectId, ids, now, reason);
  retired.push(...ids);
}

/**
 * A matched event not yet batched, or a prompt-queue wake not yet delivered. The
 * batch branch is scoped by target session to use the prompt-target index.
 */
function hasPendingWake(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  targetSessionId: string
): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM project_event_matches
         WHERE project_id = ? AND subscription_id = ? AND state = 'matched' AND batch_id IS NULL
         UNION ALL
         SELECT 1 FROM project_event_delivery_batches
         WHERE project_id = ? AND delivery_channel = 'prompt_queue' AND target_session_id = ?
           AND state = 'pending' AND subscription_id = ?
         LIMIT 1`,
        projectId,
        subscriptionId,
        projectId,
        targetSessionId,
        subscriptionId
      )
      .toArray().length > 0
  );
}
