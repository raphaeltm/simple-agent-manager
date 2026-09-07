import type {
  ProjectEventRecord,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

import {
  refreshWakeDueAtForMatches,
  refreshWakeDueAtForSubscription,
} from './project-events-due-state';
import { resolveProjectEventDelivery } from './project-events-delivery-resolver';
import { resolveProjectEventLimits } from './project-events-limits';
import { mapProjectEvent, mapProjectEventSubscription } from './project-events-mappers';
import {
  isProjectEventWakeEnabled,
  markSchedulerSuccess,
  readSchedulerState,
} from './project-events-scheduler';
import {
  claimProjectEventMatchesForBatch,
  chunkIdsForBindBudget,
  mapRows,
} from './project-events-storage-helpers';
import { EVENT_WAKE_ADAPTER_ID } from './project-events-wake-delivery';
import {
  deferWakeTarget,
  isTargetAtWakeCapacity,
  readLivePromptBatchLeaseUntilForTarget,
  resolveMailboxMaxMessages,
} from './project-events-wake-targets';
import { stableStringify } from './project-events-values';
import { subscriptionCanMatchProjectEvent } from './project-events-visibility';
import {
  type AcceptedPromptDelivery,
  type AcceptPromptDeliveryInput,
  acceptPromptDeliveryInTransaction,
} from './prompt-delivery';
import type { Env } from './types';
import { generateId } from './types';

const EVENT_WAKE_TERMINAL_REASON = 'queued for same-chat ProjectData event wake';

export type ProjectEventWakeMaterializationStatus =
  | 'materialized'
  | 'no_due_work'
  | 'not_due'
  | 'capacity_deferred'
  | 'disabled';

export type AcceptedProjectEventWake = {
  input: AcceptPromptDeliveryInput;
  accepted: AcceptedPromptDelivery;
  sourceTaskGuard: ProjectEventWakeSourceTaskGuard;
};

export type ProjectEventWakeMaterializationResult = {
  status: ProjectEventWakeMaterializationStatus;
  materialized: number;
  accepted: AcceptedProjectEventWake[];
  deferredUntil?: number | null;
};

export type ProjectEventWakeSourceTaskGuard = {
  taskId: string;
  projectId: string;
  chatSessionId: string;
};

export type ProjectEventWakeMaterializationCandidate = {
  subscriptionId: string;
  targetSessionId: string;
  targetTaskId: string | null;
  sourceTaskGuard: ProjectEventWakeSourceTaskGuard;
};

export type RunProjectEventWakeMaterializationOptions = {
  subscriptionId?: string;
  ignoreSchedulerCheckpoint?: boolean;
  recordGlobalCapacityDeferral?: boolean;
};

type BuildWakePromptInputOptions = {
  batchId: string;
  subscription: ProjectEventSubscriptionRecord;
  sourceTaskGuard: ProjectEventWakeSourceTaskGuard;
  eventIds: string[];
  now: number;
  ttlMs: number;
  maxMessages: number;
};

export function runProjectEventWakeMaterializationBatch(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now(),
  options: RunProjectEventWakeMaterializationOptions = {}
): ProjectEventWakeMaterializationResult {
  if (!projectId || !isProjectEventWakeEnabled(env)) {
    return { status: 'disabled', materialized: 0, accepted: [] };
  }
  const limits = resolveProjectEventLimits(env);
  const checkpoint = readSchedulerState(sql, projectId);
  if (
    options.ignoreSchedulerCheckpoint !== true &&
    checkpoint.nextAttemptAt !== null &&
    checkpoint.nextAttemptAt > now
  ) {
    return { status: 'not_due', materialized: 0, accepted: [] };
  }
  terminalizeIneligibleWakeMatches(sql, projectId, now, limits.wakeMaxPerSubscription);
  const candidates = selectWakeCandidates(
    sql,
    projectId,
    now,
    limits.wakeMaxPerSubscription,
    limits.maxActiveSubscriptionsPerProject,
    options.subscriptionId ?? null
  );
  if (candidates.length === 0) {
    repairStaleWakeDueAtBackstop(
      sql,
      projectId,
      now,
      Math.max(1, limits.maxActiveSubscriptionsPerProject)
    );
    markSchedulerSuccess(sql, projectId, now, 'materialization');
    return { status: 'no_due_work', materialized: 0, accepted: [] };
  }

  let deferredUntil: number | null = null;
  for (const candidate of candidates) {
    if (isTargetAtWakeCapacity(sql, env, candidate.targetSessionId)) {
      const nextAt = now + limits.wakeTargetCooldownMs;
      deferWakeTarget(sql, projectId, candidate.targetSessionId, nextAt, now);
      deferredUntil = earliestNonNull(deferredUntil, nextAt);
      continue;
    }
    const liveBatchLeaseUntil = readLivePromptBatchLeaseUntilForTarget(
      sql,
      projectId,
      candidate.targetSessionId,
      now
    );
    if (liveBatchLeaseUntil !== null) {
      deferWakeTarget(sql, projectId, candidate.targetSessionId, liveBatchLeaseUntil, now);
      deferredUntil = earliestNonNull(deferredUntil, liveBatchLeaseUntil);
      continue;
    }
    return materializeCandidate(sql, env, projectId, now, limits, candidate);
  }

  if (options.recordGlobalCapacityDeferral !== false) {
    markSchedulerSuccess(sql, projectId, now, 'materialization', deferredUntil);
  }
  return { status: 'capacity_deferred', materialized: 0, accepted: [], deferredUntil };
}

export function selectProjectEventWakeMaterializationCandidate(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): ProjectEventWakeMaterializationCandidate | null {
  return selectProjectEventWakeMaterializationCandidates(sql, env, projectId, now)[0] ?? null;
}

export function selectProjectEventWakeMaterializationCandidates(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): ProjectEventWakeMaterializationCandidate[] {
  if (!projectId || !isProjectEventWakeEnabled(env)) return [];
  const limits = resolveProjectEventLimits(env);
  const checkpoint = readSchedulerState(sql, projectId);
  if (checkpoint.nextAttemptAt !== null && checkpoint.nextAttemptAt > now) return [];
  terminalizeIneligibleWakeMatches(sql, projectId, now, limits.wakeMaxPerSubscription);
  return selectWakeCandidates(
    sql,
    projectId,
    now,
    limits.wakeMaxPerSubscription,
    limits.maxActiveSubscriptionsPerProject,
    null
  );
}

export function cancelProjectEventWakeForRevokedSourceTask(
  sql: SqlStorage,
  projectId: string,
  subscriptionId: string,
  now = Date.now()
): number {
  const updatedSubscriptions = sql.exec(
    `UPDATE project_event_subscriptions
     SET lifecycle_state = 'cancelled',
         cancelled_at = COALESCE(cancelled_at, ?),
         cancelled_by_type = COALESCE(cancelled_by_type, 'system'),
         cancelled_by_id = COALESCE(cancelled_by_id, 'project-event-wake-authority'),
         cancelled_by_name = COALESCE(cancelled_by_name, 'Project event wake authority guard'),
         cancel_reason = COALESCE(cancel_reason, ?),
         wake_due_at = NULL,
         updated_at = ?
     WHERE project_id = ?
       AND id = ?
       AND lifecycle_state = 'active'`,
    now,
    'source task authority revoked before event wake materialization',
    now,
    projectId,
    subscriptionId
  ).rowsWritten;
  const updatedMatches = sql.exec(
    `UPDATE project_event_matches
     SET state = 'cancelled',
         lifecycle_checked_at = ?,
         reason = ?
     WHERE project_id = ?
       AND subscription_id = ?
       AND batch_id IS NULL
       AND state = 'matched'`,
    now,
    'source task authority revoked before event wake materialization',
    projectId,
    subscriptionId
  ).rowsWritten;
  const updatedBatches = sql.exec(
    `UPDATE project_event_delivery_batches
     SET state = 'cancelled',
         readable_until = NULL,
         updated_at = ?,
         terminal_at = COALESCE(terminal_at, ?),
         terminal_reason = COALESCE(terminal_reason, ?)
     WHERE project_id = ?
       AND subscription_id = ?
       AND delivery_channel = 'prompt_queue'
       AND state IN ('pending', 'delivered')`,
    now,
    now,
    'source task authority revoked before event wake materialization',
    projectId,
    subscriptionId
  ).rowsWritten;
  const updatedInbox = sql.exec(
    `UPDATE session_inbox
     SET delivery_state = 'failed',
         terminal_reason = 'source_task_authority_revoked',
         last_error = 'Project event wake source task authority was revoked',
         next_attempt_at = NULL,
         attempt_started_at = NULL
     WHERE source_kind = 'project_event_wake'
       AND id IN (
         SELECT id FROM project_event_delivery_batches
         WHERE project_id = ?
           AND subscription_id = ?
           AND delivery_channel = 'prompt_queue'
       )
       AND delivery_state IN ('queued', 'retry_wait', 'delivering', 'delivered')`,
    projectId,
    subscriptionId
  ).rowsWritten;
  markSchedulerSuccess(sql, projectId, now, 'materialization');
  return updatedSubscriptions + updatedMatches + updatedBatches + updatedInbox;
}

function materializeCandidate(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  now: number,
  limits: ReturnType<typeof resolveProjectEventLimits>,
  candidate: ProjectEventWakeMaterializationCandidate
): ProjectEventWakeMaterializationResult {
  const subscription = readSubscription(sql, projectId, candidate.subscriptionId);
  const matches = selectMatchesForSubscription(
    sql,
    projectId,
    subscription.id,
    limits.maxDeliveryBatchEvents
  );
  if (matches.length === 0) {
    refreshWakeDueAtForSubscription(sql, projectId, subscription.id, now);
    markSchedulerSuccess(sql, projectId, now, 'materialization');
    return { status: 'no_due_work', materialized: 0, accepted: [] };
  }

  const events = readEvents(
    sql,
    projectId,
    matches.map((match) => match.eventId),
    limits.maxDeliveryBatchEvents
  );
  const authorized = authorizedWakeMatches(subscription, matches, events);
  if (authorized.rejected.length > 0) {
    terminalizeProjectEventWakeMatches(
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
    terminalizeProjectEventWakeMatches(
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
    sourceTaskGuard: candidate.sourceTaskGuard,
    eventIds,
    now,
    ttlMs: limits.wakePromptTtlMs,
    maxMessages: resolveMailboxMaxMessages(env),
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
  refreshWakeDueAtForSubscription(sql, projectId, subscription.id, now);
  const accepted = acceptPromptDeliveryInTransaction(sql, env, promptInput, now);
  recordQueueCheckpoint(sql, projectId, batchId, now, limits.wakeSubscriptionCooldownMs);
  markSchedulerSuccess(sql, projectId, now, 'materialization');
  return {
    status: 'materialized',
    materialized: eventIds.length,
    accepted: [{ input: promptInput, accepted, sourceTaskGuard: candidate.sourceTaskGuard }],
  };
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
    sourceTaskId: options.sourceTaskGuard.taskId,
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

function selectWakeCandidates(
  sql: SqlStorage,
  projectId: string,
  now: number,
  maxPerSubscription: number,
  limit: number,
  requiredSubscriptionId: string | null
): ProjectEventWakeMaterializationCandidate[] {
  const requiredPredicate = requiredSubscriptionId ? 'AND s.id = ?' : '';
  const params: unknown[] = [projectId, projectId, now, now, maxPerSubscription, now];
  if (requiredSubscriptionId) params.push(requiredSubscriptionId);
  params.push(Math.max(1, limit));
  const rows = sql
    .exec(
      `SELECT s.id AS subscription_id,
              s.target_session_id,
              s.target_task_id,
              s.owner_project_id,
              s.owner_chat_session_id,
              s.owner_task_id
       FROM project_event_subscriptions s
       JOIN chat_sessions c ON c.id = s.target_session_id
       WHERE s.project_id = ?
         AND s.owner_project_id = ?
         AND s.contract_version >= 2
         AND s.owner_version >= 2
         AND s.owner_type = 'agent'
         AND s.owner_chat_session_id = s.target_session_id
         AND s.owner_task_id IS NOT NULL
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (s.delivery_lifetime_expires_at IS NULL OR s.delivery_lifetime_expires_at > ?)
         AND s.prompt_delivery_count < ?
         AND s.wake_due_at IS NOT NULL
         AND (s.delivery_cooldown_until IS NULL OR s.delivery_cooldown_until <= ?)
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND s.target_session_id IS NOT NULL
         AND c.status IN ('active', 'sleeping')
         ${requiredPredicate}
       ORDER BY s.wake_due_at ASC, s.id ASC
       LIMIT ?`,
      ...params
    )
    .toArray();
  return rows
    .filter(
      (
        row
      ): row is {
        subscription_id: string;
        target_session_id: string;
        target_task_id: string | null;
        owner_project_id: string;
        owner_chat_session_id: string;
        owner_task_id: string;
      } =>
        typeof row.subscription_id === 'string' &&
        typeof row.target_session_id === 'string' &&
        (typeof row.target_task_id === 'string' || row.target_task_id === null) &&
        typeof row.owner_project_id === 'string' &&
        typeof row.owner_chat_session_id === 'string' &&
        typeof row.owner_task_id === 'string'
    )
    .map((row) => ({
      subscriptionId: row.subscription_id,
      targetSessionId: row.target_session_id,
      targetTaskId: row.target_task_id,
      sourceTaskGuard: {
        taskId: row.owner_task_id,
        projectId: row.owner_project_id,
        chatSessionId: row.owner_chat_session_id,
      },
    }));
}

function terminalizeIneligibleWakeMatches(
  sql: SqlStorage,
  projectId: string,
  now: number,
  maxPerSubscription: number
): number {
  let mutated = 0;
  mutated += terminalizeIneligibleWakeMatchesByPredicate(sql, {
    projectId,
    now,
    state: 'expired',
    reason: 'event wake subscription lifetime expired',
    predicate: `s.delivery_lifetime_expires_at IS NOT NULL AND s.delivery_lifetime_expires_at <= ?`,
    params: [now],
  });
  mutated += terminalizeIneligibleWakeMatchesByPredicate(sql, {
    projectId,
    now,
    state: 'recorded_not_injected',
    reason: 'event wake subscription delivery count exhausted',
    predicate: `s.prompt_delivery_count >= ?`,
    params: [maxPerSubscription],
  });
  mutated += terminalizeIneligibleWakeMatchesByPredicate(sql, {
    projectId,
    now,
    state: 'recorded_not_injected',
    reason: 'event wake target session is no longer active',
    predicate: `(s.target_session_id IS NULL OR c.id IS NULL OR c.status NOT IN ('active', 'sleeping'))`,
    params: [],
  });
  return mutated;
}

function terminalizeIneligibleWakeMatchesByPredicate(
  sql: SqlStorage,
  input: {
    projectId: string;
    now: number;
    state: 'expired' | 'recorded_not_injected' | 'cancelled';
    reason: string;
    predicate: string;
    params: unknown[];
  }
): number {
  const subscriptionRows = sql
    .exec(
      `SELECT s.id AS subscription_id
       FROM project_event_subscriptions s
       LEFT JOIN chat_sessions c ON c.id = s.target_session_id
       WHERE s.project_id = ?
         AND s.contract_version >= 2
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND s.lifecycle_state = 'active'
         AND s.wake_due_at IS NOT NULL
         AND (${input.predicate})
         AND EXISTS (
           SELECT 1 FROM project_event_matches m
           WHERE m.project_id = s.project_id
             AND m.subscription_id = s.id
             AND m.state = 'matched'
             AND m.batch_id IS NULL
         )
       ORDER BY s.wake_due_at ASC, s.id ASC
       LIMIT ?`,
      input.projectId,
      ...input.params,
      1
    )
    .toArray();
  const selectedSubscriptionIds = subscriptionRows
    .filter((row): row is { subscription_id: string } => typeof row.subscription_id === 'string')
    .map((row) => row.subscription_id);
  const ids: string[] = [];
  for (const subscriptionId of selectedSubscriptionIds) {
    const matchRows = sql
      .exec(
        `SELECT id
         FROM project_event_matches
         WHERE project_id = ?
           AND subscription_id = ?
           AND state = 'matched'
           AND batch_id IS NULL
         ORDER BY matched_at ASC, id ASC
         LIMIT ?`,
        input.projectId,
        subscriptionId,
        1
      )
      .toArray();
    for (const row of matchRows) {
      if (typeof row.id === 'string') ids.push(row.id);
    }
  }
  if (ids.length === 0) return 0;
  let mutated = 0;
  for (const chunk of chunkIdsForBindBudget(ids, 4)) {
    const placeholders = chunk.map(() => '?').join(', ');
    mutated += sql.exec(
      `UPDATE project_event_matches
       SET state = ?,
           lifecycle_checked_at = ?,
           reason = ?
       WHERE project_id = ?
         AND id IN (${placeholders})
         AND state = 'matched'
         AND batch_id IS NULL`,
      input.state,
      input.now,
      input.reason,
      input.projectId,
      ...chunk
    ).rowsWritten;
  }
  for (const subscriptionId of selectedSubscriptionIds) {
    refreshWakeDueAtForSubscription(sql, input.projectId, subscriptionId, input.now);
  }
  return mutated;
}

function repairStaleWakeDueAtBackstop(
  sql: SqlStorage,
  projectId: string,
  now: number,
  limit: number
): number {
  const rows = sql
    .exec(
      `SELECT s.id AS subscription_id
       FROM project_event_subscriptions s
       WHERE s.project_id = ?
         AND s.lifecycle_state = 'active'
         AND s.contract_version >= 2
         AND s.owner_version >= 2
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND s.wake_due_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM project_event_matches m
           WHERE m.project_id = s.project_id
             AND m.subscription_id = s.id
             AND m.state = 'matched'
             AND m.batch_id IS NULL
         )
       ORDER BY s.wake_due_at ASC, s.id ASC
       LIMIT ?`,
      projectId,
      limit
    )
    .toArray();
  let repaired = 0;
  for (const row of rows) {
    if (typeof row.subscription_id !== 'string') continue;
    refreshWakeDueAtForSubscription(sql, projectId, row.subscription_id, now);
    repaired += 1;
  }
  return repaired;
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

export function terminalizeProjectEventWakeMatches(
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
  for (const chunk of chunkIdsForBindBudget(matchIds, 4)) {
    const placeholders = chunk.map(() => '?').join(', ');
    sql.exec(
      `UPDATE project_event_matches
       SET state = ?, lifecycle_checked_at = ?, reason = ?
       WHERE project_id = ? AND id IN (${placeholders}) AND state = 'matched' AND batch_id IS NULL`,
      state,
      now,
      reason,
      projectId,
      ...chunk
    );
  }
  refreshWakeDueAtForMatches(sql, projectId, matchIds, now);
}

function earliestNonNull(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
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
