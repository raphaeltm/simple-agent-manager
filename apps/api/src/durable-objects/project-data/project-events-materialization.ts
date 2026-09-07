import {
  MAILBOX_DEFAULTS,
  type ProjectEventDeliveryAttemptState,
  type ProjectEventDeliveryBatchState,
  type ProjectEventRecord,
  type ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

import { resolveMaxMessagesPerSession } from './messages-persist-helpers';
import { resolveProjectEventDelivery } from './project-events-delivery-resolver';
import { resolveProjectEventLimits } from './project-events-limits';
import { mapProjectEvent, mapProjectEventSubscription } from './project-events-mappers';
import {
  claimProjectEventMatchesForBatch,
  mapRows,
  nextPhysicalAttemptNumber,
} from './project-events-storage-helpers';
import { stableStringify } from './project-events-values';
import { subscriptionCanMatchProjectEvent } from './project-events-visibility';
import { isProjectEventWakeEnabled } from './project-events-wake-config';
import {
  deferNextMaterialization,
  markSchedulerSuccess,
  readProjectEventWakeSchedulerState,
} from './project-events-wake-scheduler';
import {
  type AcceptedPromptDelivery,
  type AcceptPromptDeliveryInput,
  acceptPromptDeliveryInTransaction,
  type PromptDeliveryClaim,
  type PromptDeliveryResult,
} from './prompt-delivery';
import type { Env } from './types';
import { generateId } from './types';

export { isProjectEventWakeEnabled } from './project-events-wake-config';
export {
  hasProjectEventWakeLease,
  readProjectEventWakeLeaseUntil,
} from './project-events-wake-leases';
export {
  computeProjectEventRetentionAlarmTime,
  ensureProjectEventRetentionScheduled,
  isProjectEventRetentionDue,
  markSchedulerSuccess,
  recordSchedulerFailure,
} from './project-events-wake-scheduler';
export { invalidProjectEventWakeDeliveryTargetResult } from './project-events-wake-targets';

const EVENT_WAKE_ADAPTER_ID = 'projectdata-prompt-queue';
const EVENT_WAKE_TERMINAL_REASON = 'queued for same-chat ProjectData event wake';

export type ProjectEventWakeMaterializationStatus =
  | 'materialized'
  | 'no_due_work'
  | 'capacity_deferred'
  | 'disabled';

export type AcceptedProjectEventWake = {
  input: AcceptPromptDeliveryInput;
  accepted: AcceptedPromptDelivery;
};

export type ProjectEventWakeMaterializationResult = {
  status: ProjectEventWakeMaterializationStatus;
  materialized: number;
  accepted: AcceptedProjectEventWake[];
};

type BuildWakePromptInputOptions = {
  batchId: string;
  subscription: ProjectEventSubscriptionRecord;
  eventIds: string[];
  now: number;
  ttlMs: number;
  maxMessages: number;
};

export function computeProjectEventMaterializationAlarmTime(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): number | null {
  if (!projectId || !isProjectEventWakeEnabled(env)) return null;
  const limits = resolveProjectEventLimits(env);
  const checkpoint = readProjectEventWakeSchedulerState(sql, projectId);
  if (checkpoint.nextAttemptAt !== null) {
    return Math.max(checkpoint.nextAttemptAt, now + limits.wakeMaterializationMinAlarmDelayMs);
  }
  const row = sql
    .exec(
      `SELECT MIN(m.matched_at) AS due_at
       FROM project_event_matches m
       JOIN project_event_subscriptions s ON s.project_id = m.project_id AND s.id = m.subscription_id
       WHERE m.project_id = ?
         AND m.state = 'matched'
         AND m.batch_id IS NULL
         AND s.contract_version >= 2
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND s.target_session_id IS NOT NULL`,
      projectId,
      now
    )
    .toArray()[0];
  const dueAt = typeof row?.due_at === 'number' ? row.due_at : null;
  return dueAt === null ? null : Math.max(dueAt, now + limits.wakeMaterializationMinAlarmDelayMs);
}

export function runProjectEventWakeMaterializationBatch(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): ProjectEventWakeMaterializationResult {
  if (!projectId || !isProjectEventWakeEnabled(env)) {
    return { status: 'disabled', materialized: 0, accepted: [] };
  }
  const limits = resolveProjectEventLimits(env);
  const candidate = selectWakeCandidate(sql, projectId, now, limits.wakeMaxPerSubscription);
  if (!candidate) return { status: 'no_due_work', materialized: 0, accepted: [] };

  if (isTargetAtWakeCapacity(sql, env, candidate.target_session_id)) {
    deferNextMaterialization(sql, projectId, now + limits.wakeMaterializationMinAlarmDelayMs, now);
    return { status: 'capacity_deferred', materialized: 0, accepted: [] };
  }

  const subscription = readSubscription(sql, projectId, candidate.subscriptionId);
  const matches = selectMatchesForSubscription(
    sql,
    projectId,
    subscription.id,
    limits.maxDeliveryBatchEvents
  );
  if (matches.length === 0) return { status: 'no_due_work', materialized: 0, accepted: [] };
  if (hasLivePromptBatchForTarget(sql, projectId, candidate.target_session_id, now)) {
    deferNextMaterialization(sql, projectId, now + limits.wakeTargetCooldownMs, now);
    return { status: 'capacity_deferred', materialized: 0, accepted: [] };
  }

  const events = readEvents(
    sql,
    projectId,
    matches.map((match) => match.eventId),
    limits.maxDeliveryBatchEvents
  );
  const authorized = authorizedWakeMatches(subscription, matches, events);
  if (authorized.rejected.length > 0) {
    terminalizeMatches(
      sql,
      projectId,
      authorized.rejected,
      'recorded_not_injected',
      now,
      'event audience not authorized for wake target'
    );
  }
  if (authorized.matches.length === 0) {
    markSchedulerSuccess(sql, projectId, now, 'materialization');
    return { status: 'no_due_work', materialized: 0, accepted: [] };
  }
  const resolution = resolveProjectEventDelivery({
    subscription,
    events: authorized.events,
    now,
    maxSummaryEvents: limits.maxDeliveryBatchEvents,
    adapterCapabilities: [
      {
        adapterId: EVENT_WAKE_ADAPTER_ID,
        adapterKind: 'durable_queue',
        protocol: 'projectdata',
        protocolVersion: '1',
        capabilities: ['durable_prompt_queue'],
        durableAck: true,
        available: true,
      },
    ],
    authorization: { allowPromptQueue: true },
    targetState: 'active',
  });
  if (
    resolution.batchState !== 'pending' ||
    resolution.resolvedDelivery !== 'queued_for_prompt_delivery'
  ) {
    terminalizeMatches(
      sql,
      projectId,
      authorized.matches.map((match) => match.id),
      resolution.batchState,
      now
    );
    markSchedulerSuccess(sql, projectId, now, 'materialization');
    return { status: 'materialized', materialized: 0, accepted: [] };
  }

  const batchId = generateId();
  const matchIds = authorized.matches.map((match) => match.id);
  const eventIds = authorized.matches.map((match) => match.eventId);
  const promptInput = buildWakePromptInput({
    batchId,
    subscription,
    eventIds,
    now,
    ttlMs: limits.wakePromptTtlMs,
    maxMessages: resolveMaxMessagesPerSession(env),
  });
  insertPromptQueueBatch(
    sql,
    projectId,
    subscription,
    batchId,
    matchIds,
    eventIds.length,
    now,
    limits
  );
  const claimed = claimProjectEventMatchesForBatch(
    sql,
    projectId,
    matchIds,
    batchId,
    now,
    EVENT_WAKE_TERMINAL_REASON
  );
  if (claimed !== matchIds.length) {
    throw new Error('Project event wake match claim lost contention');
  }
  const accepted = acceptPromptDeliveryInTransaction(sql, env, promptInput, now);
  recordQueueCheckpoint(sql, projectId, batchId, now, limits.wakeSubscriptionCooldownMs);
  markSchedulerSuccess(sql, projectId, now, 'materialization');
  return {
    status: 'materialized',
    materialized: eventIds.length,
    accepted: [{ input: promptInput, accepted }],
  };
}

export function advanceProjectEventPromptAttemptCheckpoint(
  sql: SqlStorage,
  projectId: string | null,
  claim: PromptDeliveryClaim,
  result: PromptDeliveryResult,
  now = Date.now()
): void {
  if (!projectId || claim.message.sourceKind !== 'project_event_wake') return;
  const batchId = claim.message.id;
  const batch = sql
    .exec(
      `SELECT id, delivery_channel
       FROM project_event_delivery_batches
       WHERE project_id = ? AND id = ?
       LIMIT 1`,
      projectId,
      batchId
    )
    .toArray()[0];
  if (!batch || batch.delivery_channel !== 'prompt_queue') return;

  const attemptState = attemptStateForPromptResult(result);
  const idempotencyKey = `mailbox:${claim.attemptId}`;
  const attemptNumber = nextPhysicalAttemptNumber(sql, projectId, batchId);
  sql.exec(
    `INSERT OR IGNORE INTO project_event_delivery_attempts
     (id, project_id, batch_id, idempotency_key, idempotency_fingerprint, attempt_number,
      state, transport_state, adapter, protocol_version, runtime_id, receipt_id,
      error_code, error_message, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    generateId(),
    projectId,
    batchId,
    idempotencyKey,
    stableStringify([projectId, batchId, idempotencyKey, result.kind, claim.mode]),
    attemptNumber,
    attemptState,
    result.kind === 'retry' ? 'queued' : null,
    EVENT_WAKE_ADAPTER_ID,
    result.capabilities ? String(result.capabilities.protocolVersion) : null,
    result.runtimeIdentity,
    result.kind === 'accepted' || result.kind === 'ambiguous'
      ? (result.receipt?.deliveryId ?? null)
      : null,
    'reason' in result ? result.reason : null,
    'error' in result ? result.error : null,
    claim.message.lastDeliveryAt ?? now,
    now,
    now
  );
  updatePromptQueueBatchForAttempt(sql, projectId, batchId, attemptState, result, now);
}

function buildWakePromptInput(options: BuildWakePromptInputOptions): AcceptPromptDeliveryInput {
  const targetSessionId = options.subscription.deliveryPreference.target?.sessionId;
  if (!targetSessionId) throw new Error('Project event wake subscription has no target session');
  const eventIds = options.eventIds.join(', ');
  const content =
    `Project event wake batch ${options.batchId} is ready for this chat. ` +
    `Event IDs: ${eventIds}. ` +
    'Read the events through the ProjectData event MCP tools before acting on their contents. ' +
    'Checkpoint or finish through the normal chat workflow after processing this batch.';
  return {
    deliveryId: options.batchId,
    targetSessionId,
    displayContent: content,
    deliveryContent: content,
    sourceTaskId: options.subscription.deliveryPreference.target?.taskId ?? null,
    senderType: 'system',
    senderId: 'project-data',
    messageClass: 'deliver',
    sourceKind: 'project_event_wake',
    metadata: {
      projectEventWake: true,
      batchId: options.batchId,
      subscriptionId: options.subscription.id,
      eventIds: options.eventIds,
      eventCount: options.eventIds.length,
      createdAt: options.now,
      payloadPolicy: 'ids_only',
    },
    ttlMs: options.ttlMs,
    maxMessages: options.maxMessages,
  };
}

function attemptStateForPromptResult(
  result: PromptDeliveryResult
): ProjectEventDeliveryAttemptState {
  switch (result.kind) {
    case 'accepted':
      return 'accepted';
    case 'retry':
      return 'retry';
    case 'failed':
      return 'failed';
    case 'ambiguous':
      return 'ambiguous';
  }
}

function batchStateForPromptAttempt(
  attemptState: ProjectEventDeliveryAttemptState
): ProjectEventDeliveryBatchState {
  switch (attemptState) {
    case 'accepted':
      return 'delivered';
    case 'retry':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'ambiguous':
      return 'ambiguous';
    case 'recorded_not_injected':
      return 'recorded_not_injected';
  }
}

function updatePromptQueueBatchForAttempt(
  sql: SqlStorage,
  projectId: string,
  batchId: string,
  attemptState: ProjectEventDeliveryAttemptState,
  result: PromptDeliveryResult,
  now: number
): void {
  const batchState = batchStateForPromptAttempt(attemptState);
  if (attemptState === 'retry') {
    sql.exec(
      `UPDATE project_event_delivery_batches
       SET state = 'pending', updated_at = ?, terminal_reason = ?
       WHERE project_id = ?
         AND id = ?
         AND delivery_channel = 'prompt_queue'
         AND state = 'pending'`,
      now,
      'error' in result ? result.error : null,
      projectId,
      batchId
    );
    return;
  }
  sql.exec(
    `UPDATE project_event_delivery_batches
     SET state = ?,
         delivered_via = CASE WHEN ? THEN 'prompt_queue' ELSE delivered_via END,
         delivered_at = CASE WHEN ? THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
         updated_at = ?,
         terminal_at = COALESCE(terminal_at, ?),
         terminal_reason = ?
     WHERE project_id = ?
       AND id = ?
       AND delivery_channel = 'prompt_queue'
       AND state NOT IN ('acked', 'cancelled', 'expired')`,
    batchState,
    attemptState === 'accepted' ? 1 : 0,
    attemptState === 'accepted' ? 1 : 0,
    now,
    now,
    now,
    attemptState === 'accepted'
      ? 'prompt accepted by runtime'
      : 'error' in result
        ? result.error
        : result.kind,
    projectId,
    batchId
  );
}

function selectWakeCandidate(
  sql: SqlStorage,
  projectId: string,
  now: number,
  maxPerSubscription: number
): { subscriptionId: string; target_session_id: string; target_task_id: string | null } | null {
  const row = sql
    .exec(
      `SELECT s.id AS subscription_id,
              s.target_session_id,
              s.target_task_id
       FROM project_event_matches m
       JOIN project_event_subscriptions s ON s.project_id = m.project_id AND s.id = m.subscription_id
       JOIN chat_sessions c ON c.id = s.target_session_id
       WHERE m.project_id = ?
         AND m.state = 'matched'
         AND m.batch_id IS NULL
         AND s.contract_version >= 2
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (s.delivery_lifetime_expires_at IS NULL OR s.delivery_lifetime_expires_at > ?)
         AND COALESCE(s.prompt_delivery_count, 0) < ?
         AND (s.delivery_cooldown_until IS NULL OR s.delivery_cooldown_until <= ?)
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND s.target_session_id IS NOT NULL
         AND c.status IN ('active', 'sleeping')
       ORDER BY m.matched_at ASC, m.id ASC
       LIMIT 1`,
      projectId,
      now,
      now,
      maxPerSubscription,
      now
    )
    .toArray()[0];
  if (
    !row ||
    typeof row.subscription_id !== 'string' ||
    typeof row.target_session_id !== 'string'
  ) {
    return null;
  }
  return {
    subscriptionId: row.subscription_id,
    target_session_id: row.target_session_id,
    target_task_id: typeof row.target_task_id === 'string' ? row.target_task_id : null,
  };
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

function selectMatchesForSubscription(
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

function readEvents(
  sql: SqlStorage,
  projectId: string,
  eventIds: string[],
  limit: number
): ProjectEventRecord[] {
  if (eventIds.length === 0) return [];
  const placeholders = eventIds.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT *
       FROM project_events
       WHERE project_id = ? AND id IN (${placeholders})
       LIMIT ?`,
      projectId,
      ...eventIds,
      limit
    )
    .toArray();
  return mapRows(rows, mapProjectEvent, limit, 'project_event');
}

function authorizedWakeMatches(
  subscription: ProjectEventSubscriptionRecord,
  matches: Array<{ id: string; eventId: string }>,
  events: ProjectEventRecord[]
): {
  matches: Array<{ id: string; eventId: string }>;
  events: ProjectEventRecord[];
  rejected: string[];
} {
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const allowedMatches: Array<{ id: string; eventId: string }> = [];
  const allowedEvents: ProjectEventRecord[] = [];
  const rejected: string[] = [];
  for (const match of matches) {
    const event = eventsById.get(match.eventId);
    if (!event || !subscriptionCanMatchProjectEvent(subscription, event)) {
      rejected.push(match.id);
      continue;
    }
    allowedMatches.push(match);
    allowedEvents.push(event);
  }
  return { matches: allowedMatches, events: allowedEvents, rejected };
}

function insertPromptQueueBatch(
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

function recordQueueCheckpoint(
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

function terminalizeMatches(
  sql: SqlStorage,
  projectId: string,
  matchIds: string[],
  batchState: string,
  now: number,
  reason = 'event wake resolver returned terminal delivery'
): void {
  if (matchIds.length === 0) return;
  const state =
    batchState === 'cancelled'
      ? 'cancelled'
      : batchState === 'expired'
        ? 'expired'
        : 'recorded_not_injected';
  const placeholders = matchIds.map(() => '?').join(', ');
  sql.exec(
    `UPDATE project_event_matches
     SET state = ?, lifecycle_checked_at = ?, reason = ?
     WHERE project_id = ? AND id IN (${placeholders}) AND state = 'matched' AND batch_id IS NULL`,
    state,
    now,
    reason,
    projectId,
    ...matchIds
  );
}

function hasLivePromptBatchForTarget(
  sql: SqlStorage,
  projectId: string,
  sessionId: string,
  now: number
): boolean {
  const row = sql
    .exec(
      `SELECT 1
       FROM project_event_delivery_batches
       WHERE project_id = ?
         AND delivery_channel = 'prompt_queue'
         AND target_session_id = ?
         AND state IN ('pending', 'delivered')
         AND (readable_until IS NULL OR readable_until > ?)
       LIMIT 1`,
      projectId,
      sessionId,
      now
    )
    .toArray()[0];
  return Boolean(row);
}

function isTargetAtWakeCapacity(sql: SqlStorage, env: Env, sessionId: string): boolean {
  const maxTranscriptMessages = resolveMaxMessagesPerSession(env);
  const messageRow = sql
    .exec('SELECT message_count FROM chat_sessions WHERE id = ?', sessionId)
    .toArray()[0];
  const currentMessages =
    typeof messageRow?.message_count === 'number'
      ? messageRow.message_count
      : maxTranscriptMessages;
  if (currentMessages >= maxTranscriptMessages) return true;
  const maxMailboxMessages = resolveMailboxMaxMessages(env);
  const row = sql
    .exec(
      `SELECT COUNT(*) AS cnt
       FROM session_inbox
       WHERE delivery_state NOT IN ('acked', 'failed', 'ambiguous', 'expired')`
    )
    .toArray()[0];
  const activeMailboxRows = typeof row?.cnt === 'number' ? row.cnt : maxMailboxMessages;
  return activeMailboxRows >= maxMailboxMessages;
}

function resolveMailboxMaxMessages(env: Env): number {
  const parsed = Number.parseInt(env.MAILBOX_MAX_MESSAGES_PER_PROJECT ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : MAILBOX_DEFAULTS.MAX_MESSAGES_PER_PROJECT;
}
