import type {
  AckProjectEventDeliveryInput,
  GetProjectEventInput,
  ListProjectEventSubscriptionEventsInput,
  ProjectEventAgentVisibility,
  ProjectEventDeliveryAckResult,
  ProjectEventDeliveryBatchRecord,
  ProjectEventPullDeliveryInfo,
  ProjectEventPullDeliveryRecord,
  ProjectEventRecord,
  ProjectEventSubscriptionEvent,
  ProjectEventSubscriptionEventListResult,
  ProjectEventSubscriptionEventSummary,
  ProjectEventSubscriptionOwner,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';
import { isJsonRecord } from '@simple-agent-manager/shared';

import {
  ProjectEventAckPolicyError,
  ProjectEventAckStateError,
  ProjectEventValidationError,
} from './project-events-contracts';
import {
  decodeProjectEventSubscriptionEventsCursor,
  encodeProjectEventSubscriptionEventsCursor,
} from './project-events-cursors';
import { resolveProjectEventDelivery } from './project-events-delivery-resolver';
import { resolveProjectEventLimits } from './project-events-limits';
import { mapProjectEvent, mapProjectEventDeliveryBatch } from './project-events-mappers';
import {
  assertProjectBinding,
  normalizeListLimit,
  normalizeProjectId,
} from './project-events-normalization';
import {
  expireDueSubscriptions,
  readBatchById,
  readEventById,
  readSubscriptionById,
} from './project-events-storage-helpers';
import { normalizeText, stableStringify } from './project-events-values';
import type { Env } from './types';
import { generateId } from './types';

type MatchCursor = {
  id: string;
  eventId: string;
  subscriptionId: string;
  state: string;
  matchedAt: number;
  lifecycleCheckedAt: number;
  batchId: string | null;
  reason: string | null;
};

type MatchEventRow = Record<string, unknown> & {
  match_id: string;
  match_event_id: string;
  match_subscription_id: string;
  match_state: string;
  match_matched_at: number;
  match_lifecycle_checked_at: number;
  match_batch_id: string | null;
  match_reason: string | null;
};

const NONDISCLOSING_EVENT_MISS = null;
const PULL_ACK_TERMINAL_REASON = 'acknowledged by pull consumer';
const PULL_DELIVERY_REASON = 'delivered through MCP pull replay';

export function getProjectEvent(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: GetProjectEventInput
): ProjectEventSubscriptionEvent | null {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const eventId = normalizeText(input.eventId, 'eventId', limits.maxFilterStringBytes);
  const visibility = normalizeVisibility(input.visibility, limits.maxFilterStringBytes);
  const now = Date.now();
  expireDueSubscriptions(sql, projectId, now, limits.retentionBatchRows);

  const match = readVisibleMatchForEvent(sql, projectId, eventId, visibility, now);
  if (!match) return NONDISCLOSING_EVENT_MISS;
  const event = readEventById(sql, projectId, eventId);
  const subscription = readSubscriptionById(sql, projectId, match.subscriptionId);
  const batch = ensurePullDeliveryBatch(sql, env, projectId, subscription, match, event, now);
  return eventForResponse(event, match, batch);
}

export function listProjectEventSubscriptionEvents(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: ListProjectEventSubscriptionEventsInput
): ProjectEventSubscriptionEventListResult | null {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const subscriptionId = normalizeText(
    input.subscriptionId,
    'subscriptionId',
    limits.maxFilterStringBytes
  );
  const visibility = normalizeVisibility(input.visibility, limits.maxFilterStringBytes);
  const limit = normalizeListLimit(input.limit, limits);
  const cursorMaxLength = normalizeCursorMaxLength(input.cursorMaxLength, limits);
  const now = Date.now();
  expireDueSubscriptions(sql, projectId, now, limits.retentionBatchRows);

  const subscription = readVisibleSubscription(sql, projectId, subscriptionId, visibility, now);
  if (!subscription) return null;

  const cursor = input.cursor
    ? decodeProjectEventSubscriptionEventsCursor(input.cursor, subscriptionId, cursorMaxLength)
    : {
        version: 1 as const,
        subscriptionId,
        afterMatchedAt: 0,
        afterMatchId: '',
      };

  const rows = sql
    .exec(
      `SELECT m.id AS match_id,
              m.event_id AS match_event_id,
              m.subscription_id AS match_subscription_id,
              m.state AS match_state,
              m.matched_at AS match_matched_at,
              m.lifecycle_checked_at AS match_lifecycle_checked_at,
              m.batch_id AS match_batch_id,
              m.reason AS match_reason,
              e.*
       FROM project_event_matches m
       JOIN project_events e ON e.project_id = m.project_id AND e.id = m.event_id
       WHERE m.project_id = ?
         AND m.subscription_id = ?
         AND m.state NOT IN ('expired', 'cancelled')
         AND (m.matched_at > ? OR (m.matched_at = ? AND m.id > ?))
       ORDER BY m.matched_at ASC, m.id ASC
       LIMIT ?`,
      projectId,
      subscriptionId,
      cursor.afterMatchedAt,
      cursor.afterMatchedAt,
      cursor.afterMatchId,
      limit + 1
    )
    .toArray();

  const page = rows.slice(0, limit);
  const events = page.map((row) => {
    const parsed = parseMatchEventRow(row);
    const event = mapProjectEvent(row);
    const batch = ensurePullDeliveryBatch(sql, env, projectId, subscription, parsed, event, now);
    return eventSummaryForResponse(event, parsed, batch);
  });
  const last = page.length > 0 ? parseMatchEventRow(page[page.length - 1]) : null;

  return {
    subscriptionId,
    events,
    nextCursor:
      rows.length > limit && last
        ? encodeProjectEventSubscriptionEventsCursor({
            version: 1,
            subscriptionId,
            afterMatchedAt: last.matchedAt,
            afterMatchId: last.id,
          })
        : null,
    hasMore: rows.length > limit,
  };
}

export function ackProjectEventDelivery(
  sql: SqlStorage,
  env: Env,
  storedProjectId: string | null,
  input: AckProjectEventDeliveryInput
): ProjectEventDeliveryAckResult | null {
  const limits = resolveProjectEventLimits(env);
  const projectId = normalizeProjectId(input.projectId, limits);
  assertProjectBinding(storedProjectId, projectId);
  const deliveryId = normalizeText(input.deliveryId, 'deliveryId', limits.maxFilterStringBytes);
  const visibility = normalizeVisibility(input.visibility, limits.maxFilterStringBytes);
  const acknowledgedBy = normalizeOwner(input.acknowledgedBy, limits.maxFilterStringBytes);
  const now = Date.now();
  expireDueSubscriptions(sql, projectId, now, limits.retentionBatchRows);

  const visible = readVisibleDelivery(sql, projectId, deliveryId, visibility, now);
  if (!visible) return null;
  if (!visible.batch.ackRequired) throw new ProjectEventAckPolicyError();
  if (visible.batch.state === 'acked') {
    return {
      acknowledged: true,
      idempotent: true,
      delivery: deliveryRecordForResponse(visible.batch, visible.eventIds),
    };
  }
  if (!isAckableState(visible.batch.state)) throw new ProjectEventAckStateError();

  sql.exec(
    `UPDATE project_event_delivery_batches
     SET state = 'acked',
         ack_required = 1,
         delivered_at = COALESCE(delivered_at, ?),
         acked_at = COALESCE(acked_at, ?),
         acked_by_type = COALESCE(acked_by_type, ?),
         acked_by_id = COALESCE(acked_by_id, ?),
         acked_by_name = COALESCE(acked_by_name, ?),
         updated_at = ?,
         terminal_at = COALESCE(terminal_at, ?),
         terminal_reason = COALESCE(terminal_reason, ?)
     WHERE project_id = ?
       AND id = ?
       AND state IN ('pending', 'recorded_not_injected', 'delivered')`,
    now,
    now,
    acknowledgedBy.type,
    acknowledgedBy.id,
    acknowledgedBy.name ?? null,
    now,
    now,
    PULL_ACK_TERMINAL_REASON,
    projectId,
    deliveryId
  );

  const updated = readVisibleDelivery(sql, projectId, deliveryId, visibility, now);
  if (!updated) return null;
  return {
    acknowledged: true,
    idempotent: false,
    delivery: deliveryRecordForResponse(updated.batch, updated.eventIds),
  };
}

function readVisibleSubscription(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  visibility: ProjectEventAgentVisibility,
  now: number
): ProjectEventSubscriptionRecord | null {
  const row = sql
    .exec(
      `SELECT *
       FROM project_event_subscriptions s
       WHERE s.project_id = ?
         AND s.id = ?
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND ${visibleSubscriptionPredicate('s')}`,
      projectId,
      subscriptionId,
      now,
      ...visibilityParams(visibility)
    )
    .toArray()[0];
  return row ? readSubscriptionById(sql, projectId, subscriptionId) : null;
}

function readVisibleMatchForEvent(
  sql: SqlStorage,
  projectId: string,
  eventId: string,
  visibility: ProjectEventAgentVisibility,
  now: number
): MatchCursor | null {
  const row = sql
    .exec(
      `SELECT m.id AS match_id,
              m.event_id AS match_event_id,
              m.subscription_id AS match_subscription_id,
              m.state AS match_state,
              m.matched_at AS match_matched_at,
              m.lifecycle_checked_at AS match_lifecycle_checked_at,
              m.batch_id AS match_batch_id,
              m.reason AS match_reason
       FROM project_event_matches m
       JOIN project_event_subscriptions s ON s.project_id = m.project_id AND s.id = m.subscription_id
       WHERE m.project_id = ?
         AND m.event_id = ?
         AND m.state NOT IN ('expired', 'cancelled')
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND ${visibleSubscriptionPredicate('s')}
       ORDER BY m.matched_at ASC, m.id ASC
       LIMIT 1`,
      projectId,
      eventId,
      now,
      ...visibilityParams(visibility)
    )
    .toArray()[0];
  return row ? parseMatchEventRow(row) : null;
}

function readVisibleDelivery(
  sql: SqlStorage,
  projectId: string,
  deliveryId: string,
  visibility: ProjectEventAgentVisibility,
  now: number
): { batch: ProjectEventDeliveryBatchRecord; eventIds: string[] } | null {
  const row = sql
    .exec(
      `SELECT b.*
       FROM project_event_delivery_batches b
       JOIN project_event_subscriptions s ON s.project_id = b.project_id AND s.id = b.subscription_id
       WHERE b.project_id = ?
         AND b.id = ?
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND ${visibleSubscriptionPredicate('s')}
       LIMIT 1`,
      projectId,
      deliveryId,
      now,
      ...visibilityParams(visibility)
    )
    .toArray()[0];
  if (!row) return null;
  const batch = mapProjectEventDeliveryBatch(row);
  return { batch, eventIds: readEventIdsForBatch(sql, projectId, batch.id) };
}

function visibleSubscriptionPredicate(alias: string): string {
  return `((
           ${alias}.owner_type = ?
           AND ${alias}.owner_id = ?
           AND ${alias}.target_session_id = ?
         )
         OR (
           ${alias}.owner_type IN ('policy', 'system', 'standing_watch')
           AND (
             (${alias}.target_task_id IS NOT NULL AND ${alias}.target_task_id = ?)
             OR (${alias}.target_session_id IS NOT NULL AND ${alias}.target_session_id = ?)
             OR (${alias}.target_agent_id IS NOT NULL AND ${alias}.target_agent_id = ?)
           )
         ))`;
}

function visibilityParams(visibility: ProjectEventAgentVisibility): unknown[] {
  return [
    visibility.owner.type,
    visibility.owner.id,
    visibility.target.sessionId ?? null,
    visibility.target.taskId ?? null,
    visibility.target.sessionId ?? null,
    visibility.target.agentId ?? null,
  ];
}

function ensurePullDeliveryBatch(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  subscription: ProjectEventSubscriptionRecord,
  match: MatchCursor,
  event: ProjectEventRecord,
  now: number
): ProjectEventDeliveryBatchRecord {
  if (match.batchId) {
    return markBatchObservedForPull(
      sql,
      projectId,
      readBatchById(sql, projectId, match.batchId),
      now
    );
  }
  return createPullDeliveryBatch(sql, env, projectId, subscription, match, event, now);
}

function createPullDeliveryBatch(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  subscription: ProjectEventSubscriptionRecord,
  match: MatchCursor,
  event: ProjectEventRecord,
  now: number
): ProjectEventDeliveryBatchRecord {
  const limits = resolveProjectEventLimits(env);
  const resolution = resolveProjectEventDelivery({
    subscription,
    requestedDelivery: subscription.deliveryPreference.requested,
    target: subscription.deliveryPreference.target,
    events: [event],
    now,
    maxSummaryEvents: limits.maxDeliveryBatchEvents,
  });
  const batchId = generateId();
  const idempotencyKey = `pull:${match.id}`;
  const idempotencyFingerprint = stableStringify([projectId, subscription.id, match.id, event.id]);
  sql.exec(
    `INSERT INTO project_event_delivery_batches
     (id, project_id, subscription_id, idempotency_key, idempotency_fingerprint, state,
      ack_required, requested_delivery, resolved_delivery, adapter_decision_json,
      target_session_id, target_task_id, target_runtime_id, target_agent_id,
      match_ids_json, event_count, created_at, updated_at, delivered_at, terminal_at,
      terminal_reason)
     VALUES (?, ?, ?, ?, ?, 'delivered', 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    batchId,
    projectId,
    subscription.id,
    idempotencyKey,
    idempotencyFingerprint,
    resolution.requestedDelivery,
    resolution.resolvedDelivery,
    stableStringify(resolution.adapterDecision),
    resolution.target.sessionId ?? null,
    resolution.target.taskId ?? null,
    resolution.target.runtimeId ?? null,
    resolution.target.agentId ?? null,
    stableStringify([match.id]),
    now,
    now,
    now,
    now,
    resolution.terminalReason ?? PULL_DELIVERY_REASON
  );
  sql.exec(
    `UPDATE project_event_matches
     SET batch_id = ?, state = 'batch_created', lifecycle_checked_at = ?, reason = ?
     WHERE project_id = ? AND id = ? AND batch_id IS NULL`,
    batchId,
    now,
    PULL_DELIVERY_REASON,
    projectId,
    match.id
  );
  return readBatchById(sql, projectId, batchId);
}

function markBatchObservedForPull(
  sql: SqlStorage,
  projectId: string,
  batch: ProjectEventDeliveryBatchRecord,
  now: number
): ProjectEventDeliveryBatchRecord {
  if (batch.state === 'acked') return batch;
  if (
    batch.state === 'failed' ||
    batch.state === 'ambiguous' ||
    batch.state === 'expired' ||
    batch.state === 'cancelled'
  ) {
    return batch;
  }
  sql.exec(
    `UPDATE project_event_delivery_batches
     SET ack_required = 1,
         delivered_at = COALESCE(delivered_at, ?),
         state = CASE
           WHEN state IN ('pending', 'recorded_not_injected') THEN 'delivered'
           ELSE state
         END,
         updated_at = ?,
         terminal_at = COALESCE(terminal_at, ?),
         terminal_reason = COALESCE(terminal_reason, ?)
     WHERE project_id = ? AND id = ?`,
    now,
    now,
    now,
    PULL_DELIVERY_REASON,
    projectId,
    batch.id
  );
  return readBatchById(sql, projectId, batch.id);
}

function readEventIdsForBatch(sql: SqlStorage, projectId: string, batchId: string): string[] {
  return sql
    .exec(
      `SELECT event_id
       FROM project_event_matches
       WHERE project_id = ? AND batch_id = ?
       ORDER BY matched_at ASC, id ASC`,
      projectId,
      batchId
    )
    .toArray()
    .filter(
      (row): row is { event_id: string } => isJsonRecord(row) && typeof row.event_id === 'string'
    )
    .map((row) => row.event_id);
}

function parseMatchEventRow(row: unknown): MatchCursor {
  if (!isJsonRecord(row)) throw new ProjectEventValidationError('event match row is invalid');
  const parsed = row as MatchEventRow;
  if (
    typeof parsed.match_id !== 'string' ||
    typeof parsed.match_event_id !== 'string' ||
    typeof parsed.match_subscription_id !== 'string' ||
    typeof parsed.match_state !== 'string' ||
    typeof parsed.match_matched_at !== 'number' ||
    typeof parsed.match_lifecycle_checked_at !== 'number' ||
    (typeof parsed.match_batch_id !== 'string' && parsed.match_batch_id !== null) ||
    (typeof parsed.match_reason !== 'string' && parsed.match_reason !== null)
  ) {
    throw new ProjectEventValidationError('event match row is invalid');
  }
  return {
    id: parsed.match_id,
    eventId: parsed.match_event_id,
    subscriptionId: parsed.match_subscription_id,
    state: parsed.match_state,
    matchedAt: parsed.match_matched_at,
    lifecycleCheckedAt: parsed.match_lifecycle_checked_at,
    batchId: parsed.match_batch_id,
    reason: parsed.match_reason,
  };
}

function eventSummaryForResponse(
  event: ProjectEventRecord,
  match: MatchCursor,
  batch: ProjectEventDeliveryBatchRecord
): ProjectEventSubscriptionEventSummary {
  return {
    id: event.id,
    source: event.source,
    eventType: event.eventType,
    subject: event.subject,
    severity: event.severity,
    metadata: event.metadata,
    display: event.display,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    matchId: match.id,
    payloadRefAvailable: event.rawPayloadRef !== null,
    delivery: deliveryInfoForResponse(batch),
  };
}

function eventForResponse(
  event: ProjectEventRecord,
  match: MatchCursor,
  batch: ProjectEventDeliveryBatchRecord
): ProjectEventSubscriptionEvent {
  return {
    ...eventSummaryForResponse(event, match, batch),
    projectId: event.projectId,
    contractVersion: event.contractVersion,
    deliveryKey: event.deliveryKey,
    payloadFingerprint: event.payloadFingerprint,
    rawPayloadRef: event.rawPayloadRef,
    updatedAt: event.updatedAt,
    state: event.state,
    duplicateCount: event.duplicateCount,
    conflictCount: event.conflictCount,
    conflictFingerprint: event.conflictFingerprint,
    conflictDetectedAt: event.conflictDetectedAt,
  };
}

function deliveryInfoForResponse(
  batch: ProjectEventDeliveryBatchRecord
): ProjectEventPullDeliveryInfo {
  return {
    id: batch.id,
    subscriptionId: batch.subscriptionId,
    state: batch.state,
    ackRequired: batch.ackRequired,
    requestedDelivery: batch.requestedDelivery,
    resolvedDelivery: batch.resolvedDelivery,
    createdAt: batch.createdAt,
    deliveredAt: batch.deliveredAt,
    acknowledgedAt: batch.ackedAt,
  };
}

function deliveryRecordForResponse(
  batch: ProjectEventDeliveryBatchRecord,
  eventIds: string[]
): ProjectEventPullDeliveryRecord {
  return {
    ...deliveryInfoForResponse(batch),
    eventId: eventIds[0] ?? null,
    eventIds,
  };
}

function isAckableState(state: ProjectEventDeliveryBatchRecord['state']): boolean {
  return state === 'pending' || state === 'recorded_not_injected' || state === 'delivered';
}

function normalizeVisibility(
  visibility: ProjectEventAgentVisibility,
  maxBytes: number
): ProjectEventAgentVisibility {
  return {
    owner: normalizeOwner(visibility.owner, maxBytes),
    target: {
      sessionId: normalizeNullableVisibilityText(
        visibility.target.sessionId,
        'target.sessionId',
        maxBytes
      ),
      taskId: normalizeNullableVisibilityText(visibility.target.taskId, 'target.taskId', maxBytes),
      runtimeId: normalizeNullableVisibilityText(
        visibility.target.runtimeId,
        'target.runtimeId',
        maxBytes
      ),
      agentId: normalizeNullableVisibilityText(
        visibility.target.agentId,
        'target.agentId',
        maxBytes
      ),
    },
  };
}

function normalizeOwner(
  owner: ProjectEventSubscriptionOwner,
  maxBytes: number
): ProjectEventSubscriptionOwner {
  return {
    type: owner.type,
    id: normalizeText(owner.id, 'owner.id', maxBytes),
    name: normalizeNullableVisibilityText(owner.name ?? null, 'owner.name', maxBytes),
  };
}

function normalizeNullableVisibilityText(
  value: string | null | undefined,
  field: string,
  maxBytes: number
): string | null {
  if (value === undefined || value === null) return null;
  return normalizeText(value, field, maxBytes);
}

function normalizeCursorMaxLength(
  input: number | null | undefined,
  limits: { subscriptionEventCursorMaxLength: number }
): number {
  if (input === null || input === undefined) return limits.subscriptionEventCursorMaxLength;
  if (!Number.isInteger(input) || input <= 0) {
    throw new ProjectEventValidationError('cursorMaxLength must be a positive integer');
  }
  return input;
}
