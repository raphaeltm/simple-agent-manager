import type {
  ProjectEventRecord,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

import { mapProjectEvent, mapProjectEventSubscription } from './project-events-mappers';
import { subscriptionCanMatchProjectEvent } from './project-events-visibility';
import { isProjectEventWakeEnabled } from './project-events-wake-config';
import type { PromptDeliveryClaim, PromptDeliveryResult } from './prompt-delivery';
import type { Env } from './types';

export function invalidProjectEventWakeDeliveryTargetResult(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  claim: PromptDeliveryClaim,
  now = Date.now()
): PromptDeliveryResult | null {
  if (claim.message.sourceKind !== 'project_event_wake') return null;
  if (!projectId || !isProjectEventWakeEnabled(env)) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: !projectId
        ? 'Project event wake has no project identity'
        : 'Project event wake delivery is disabled',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const row = sql
    .exec(
      `SELECT b.id,
              b.subscription_id,
              b.target_session_id,
              b.delivery_expires_at,
              s.lifecycle_state,
              s.expires_at,
              s.delivery_lifetime_expires_at,
              c.status AS chat_status
       FROM project_event_delivery_batches b
       JOIN project_event_subscriptions s
         ON s.project_id = b.project_id AND s.id = b.subscription_id
       LEFT JOIN chat_sessions c ON c.id = b.target_session_id
       WHERE b.project_id = ?
         AND b.id = ?
         AND b.delivery_channel = 'prompt_queue'
         AND b.state = 'pending'
       LIMIT 1`,
      projectId,
      claim.message.id
    )
    .toArray()[0];
  if (!row) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Project event wake batch is no longer pending',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const subscriptionId = typeof row.subscription_id === 'string' ? row.subscription_id : null;
  const targetSessionId = typeof row.target_session_id === 'string' ? row.target_session_id : null;
  const expiresAt = typeof row.delivery_expires_at === 'number' ? row.delivery_expires_at : null;
  const subscriptionExpiresAt = typeof row.expires_at === 'number' ? row.expires_at : null;
  const lifetimeExpiresAt =
    typeof row.delivery_lifetime_expires_at === 'number' ? row.delivery_lifetime_expires_at : null;
  const chatStatus = typeof row.chat_status === 'string' ? row.chat_status : null;
  if (
    targetSessionId !== claim.message.targetSessionId ||
    row.lifecycle_state !== 'active' ||
    (expiresAt !== null && expiresAt <= now) ||
    (subscriptionExpiresAt !== null && subscriptionExpiresAt <= now) ||
    (lifetimeExpiresAt !== null && lifetimeExpiresAt <= now) ||
    (chatStatus !== 'active' && chatStatus !== 'sleeping')
  ) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error:
        targetSessionId !== claim.message.targetSessionId
          ? 'Project event wake target session binding changed'
          : row.lifecycle_state !== 'active'
            ? 'Project event wake subscription is no longer active'
            : chatStatus !== 'active' && chatStatus !== 'sleeping'
              ? 'Project event wake target session is no longer active'
              : 'Project event wake delivery lease expired',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  if (!subscriptionId) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Project event wake subscription binding is missing',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  const subscription = readSubscription(sql, projectId, subscriptionId);
  const events = readEventsForBatch(sql, projectId, claim.message.id);
  if (events.some((event) => !subscriptionCanMatchProjectEvent(subscription, event))) {
    return {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Project event wake audience is no longer authorized for target',
      runtimeIdentity: claim.message.runtimeIdentity,
      capabilities: null,
    };
  }
  return null;
}

function readSubscription(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string
): ProjectEventSubscriptionRecord {
  return mapProjectEventSubscription(
    sql
      .exec(
        `SELECT *
         FROM project_event_subscriptions
         WHERE project_id = ? AND id = ?
         LIMIT 1`,
        projectId,
        subscriptionId
      )
      .toArray()[0]
  );
}

function readEventsForBatch(
  sql: SqlStorage,
  projectId: string,
  batchId: string
): ProjectEventRecord[] {
  return sql
    .exec(
      `SELECT e.*
       FROM project_event_matches m
       JOIN project_events e ON e.project_id = m.project_id AND e.id = m.event_id
       WHERE m.project_id = ? AND m.batch_id = ?
       ORDER BY m.matched_at ASC, m.id ASC`,
      projectId,
      batchId
    )
    .toArray()
    .map(mapProjectEvent);
}
