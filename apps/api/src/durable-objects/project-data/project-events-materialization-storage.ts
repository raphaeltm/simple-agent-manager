import type { ProjectEventRecord, ProjectEventSubscriptionRecord } from '@simple-agent-manager/shared';

import type { resolveProjectEventLimits } from './project-events-limits';
import { mapProjectEvent, mapProjectEventSubscription } from './project-events-mappers';
import { chunkIdsForBindBudget, mapRows } from './project-events-storage-helpers';
import { stableStringify } from './project-events-values';
import { EVENT_WAKE_ADAPTER_ID } from './project-events-wake-delivery';
import { generateId } from './types';

export function insertPromptQueueBatch(
  sql: SqlStorage,
  projectId: string,
  subscription: ProjectEventSubscriptionRecord,
  batchId: string,
  matchIds: string[],
  eventCount: number,
  now: number,
  limits: ReturnType<typeof resolveProjectEventLimits>
): void {
  sql.exec(
    `INSERT INTO project_event_delivery_batches
     (id, project_id, subscription_id, idempotency_key, idempotency_fingerprint, state,
      delivery_channel, delivery_expires_at, readable_until, ack_required,
      requested_delivery, resolved_delivery, adapter_decision_json,
      target_session_id, target_task_id, target_runtime_id, target_agent_id,
      match_ids_json, event_count, created_at, updated_at, terminal_reason)
     VALUES (?, ?, ?, ?, ?, 'pending', 'prompt_queue', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    batchId,
    projectId,
    subscription.id,
    `event-wake:${batchId}`,
    stableStringify([projectId, subscription.id, matchIds]),
    now + limits.wakePromptTtlMs,
    now + limits.wakeReadGraceMs,
    subscription.deliveryPreference.requested,
    'queued_for_prompt_delivery',
    stableStringify({
      action: 'queue_prompt_delivery',
      reason: 'adapter_supported',
      adapterId: EVENT_WAKE_ADAPTER_ID,
      adapterKind: 'durable_queue',
      capability: 'durable_prompt_queue',
      agentType: null,
      protocol: 'projectdata',
      protocolVersion: '1',
      durableAck: true,
      supported: true,
      authorized: true,
      terminal: false,
    }),
    subscription.deliveryPreference.target?.sessionId ?? null,
    subscription.deliveryPreference.target?.taskId ?? null,
    subscription.deliveryPreference.target?.runtimeId ?? null,
    subscription.deliveryPreference.target?.agentId ?? null,
    stableStringify(matchIds),
    eventCount,
    now,
    now,
    null
  );
}

export function recordQueueCheckpoint(
  sql: SqlStorage,
  projectId: string,
  batchId: string,
  now: number,
  subscriptionCooldownMs: number
): void {
  sql.exec(
    `INSERT OR IGNORE INTO project_event_delivery_attempts
     (id, project_id, batch_id, idempotency_key, idempotency_fingerprint, attempt_number,
      state, transport_state, adapter, protocol_version, runtime_id, receipt_id,
      error_code, error_message, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'retry', 'queued', ?, '1', NULL, NULL, NULL, NULL, ?, NULL, ?)`,
    generateId(),
    projectId,
    batchId,
    `mailbox:queue:${batchId}`,
    stableStringify([projectId, batchId, `mailbox:queue:${batchId}`, EVENT_WAKE_ADAPTER_ID]),
    EVENT_WAKE_ADAPTER_ID,
    now,
    now
  );
  sql.exec(
    `UPDATE project_event_subscriptions
     SET prompt_delivery_count = prompt_delivery_count + 1,
         prompt_delivery_last_at = ?,
         delivery_cooldown_until = ?,
         updated_at = ?
     WHERE project_id = ?
       AND id = (SELECT subscription_id FROM project_event_delivery_batches WHERE project_id = ? AND id = ?)`,
    now,
    now + subscriptionCooldownMs,
    now,
    projectId,
    projectId,
    batchId
  );
}

export function readSubscription(
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

export function selectMatchesForSubscription(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  limit: number
): Array<{ id: string; eventId: string }> {
  return sql
    .exec(
      `SELECT id, event_id
       FROM project_event_matches
       WHERE project_id = ?
         AND subscription_id = ?
         AND state = 'matched'
         AND batch_id IS NULL
       ORDER BY matched_at ASC, id ASC
       LIMIT ?`,
      projectId,
      subscriptionId,
      limit
    )
    .toArray()
    .filter(
      (row): row is { id: string; event_id: string } =>
        typeof row.id === 'string' && typeof row.event_id === 'string'
    )
    .map((row) => ({ id: row.id, eventId: row.event_id }));
}

export function readEvents(
  sql: SqlStorage,
  projectId: string,
  eventIds: string[],
  limit: number
): ProjectEventRecord[] {
  if (eventIds.length === 0) return [];
  const rows: unknown[] = [];
  for (const chunk of chunkIdsForBindBudget(eventIds.slice(0, limit), 2)) {
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(
      ...sql
        .exec(
          `SELECT *
           FROM project_events
           WHERE project_id = ? AND id IN (${placeholders})
           LIMIT ?`,
          projectId,
          ...chunk,
          Math.max(0, limit - rows.length)
        )
        .toArray()
    );
    if (rows.length >= limit) break;
  }
  return mapRows(rows, mapProjectEvent, limit, 'project_event');
}
