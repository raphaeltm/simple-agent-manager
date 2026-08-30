import type {
  ProjectEventDeliveryAdapterDecision,
  ProjectEventDeliveryAttemptRecord,
  ProjectEventDeliveryBatchRecord,
  ProjectEventDisplayData,
  ProjectEventFilterV1,
  ProjectEventMatchRecord,
  ProjectEventMetadata,
  ProjectEventRawPayloadRef,
  ProjectEventRecord,
  ProjectEventStorageAccountingRecord,
  ProjectEventSubscriptionOwner,
  ProjectEventSubscriptionRecord,
} from '@simple-agent-manager/shared';

import {
  parseProjectEventDeliveryAttemptRow,
  parseProjectEventDeliveryBatchRow,
  parseProjectEventMatchRow,
  parseProjectEventRow,
  parseProjectEventStorageAccountingRow,
  parseProjectEventSubscriptionRow,
  safeParseJson,
} from './row-schemas';
import type { ProjectEventDeliveryBatchRow } from './row-schemas/project-events';

function parseJsonColumn<T>(value: string | null, context: string): T {
  const parsed = safeParseJson(value);
  if (parsed === null) throw new Error(`Invalid JSON in ${context}`);
  return parsed as T;
}

function parseAdapterDecisionColumn(
  value: string | null,
  fallback: ProjectEventDeliveryAdapterDecision
): ProjectEventDeliveryAdapterDecision {
  if (!value) return fallback;
  return parseJsonColumn<ProjectEventDeliveryAdapterDecision>(
    value,
    'project_event_delivery_batches.adapter_decision_json'
  );
}

function ownerFromColumns(
  type: ProjectEventSubscriptionOwner['type'] | null,
  id: string | null,
  name: string | null
): ProjectEventSubscriptionOwner | null {
  if (!type || !id) return null;
  return { type, id, name };
}

export function mapProjectEvent(row: unknown): ProjectEventRecord {
  const parsed = parseProjectEventRow(row);
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    contractVersion: 1,
    source: parsed.source,
    eventType: parsed.event_type,
    subject: {
      type: parsed.subject_type,
      id: parsed.subject_id,
    },
    severity: parsed.severity,
    deliveryKey: parsed.delivery_key,
    payloadFingerprint: parsed.payload_fingerprint,
    metadata: parseJsonColumn<ProjectEventMetadata>(
      parsed.metadata_json,
      'project_events.metadata_json'
    ),
    display: parseJsonColumn<ProjectEventDisplayData>(
      parsed.display_json,
      'project_events.display_json'
    ),
    rawPayloadRef: parsed.raw_payload_ref_json
      ? parseJsonColumn<ProjectEventRawPayloadRef>(
          parsed.raw_payload_ref_json,
          'project_events.raw_payload_ref_json'
        )
      : null,
    occurredAt: parsed.occurred_at,
    receivedAt: parsed.received_at,
    updatedAt: parsed.updated_at,
    state: parsed.state,
    duplicateCount: parsed.duplicate_count,
    conflictCount: parsed.conflict_count,
    conflictFingerprint: parsed.conflict_fingerprint,
    conflictDetectedAt: parsed.conflict_detected_at,
  };
}

export function mapProjectEventSubscription(row: unknown): ProjectEventSubscriptionRecord {
  const parsed = parseProjectEventSubscriptionRow(row);
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    contractVersion: 1,
    owner: {
      type: parsed.owner_type,
      id: parsed.owner_id,
      name: parsed.owner_name,
    },
    idempotencyKey: parsed.idempotency_key,
    filter: parseJsonColumn<ProjectEventFilterV1>(
      parsed.filter_json,
      'project_event_subscriptions.filter_json'
    ),
    filterFingerprint: parsed.filter_fingerprint,
    matchKeyCount: parsed.match_key_count,
    deliveryPreference: {
      requested: parsed.requested_delivery,
      resolved: parsed.resolved_delivery,
      target: {
        sessionId: parsed.target_session_id,
        taskId: parsed.target_task_id,
        runtimeId: parsed.target_runtime_id,
        agentId: parsed.target_agent_id,
      },
    },
    state: parsed.lifecycle_state,
    reason: parsed.reason,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    expiresAt: parsed.expires_at,
    cancelledAt: parsed.cancelled_at,
    cancelledBy: ownerFromColumns(
      parsed.cancelled_by_type,
      parsed.cancelled_by_id,
      parsed.cancelled_by_name
    ),
    cancelReason: parsed.cancel_reason,
    lastMatchedAt: parsed.last_matched_at,
  };
}

export function mapProjectEventMatch(row: unknown): ProjectEventMatchRecord {
  const parsed = parseProjectEventMatchRow(row);
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    eventId: parsed.event_id,
    subscriptionId: parsed.subscription_id,
    state: parsed.state,
    matchedAt: parsed.matched_at,
    lifecycleCheckedAt: parsed.lifecycle_checked_at,
    batchId: parsed.batch_id,
    reason: parsed.reason,
  };
}

export function mapProjectEventDeliveryBatch(row: unknown): ProjectEventDeliveryBatchRecord {
  const parsed = parseProjectEventDeliveryBatchRow(row);
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    subscriptionId: parsed.subscription_id,
    idempotencyKey: parsed.idempotency_key,
    state: parsed.state,
    ackRequired: parsed.ack_required === 1,
    requestedDelivery: parsed.requested_delivery,
    resolvedDelivery: parsed.resolved_delivery,
    adapterDecision: parseAdapterDecisionColumn(
      parsed.adapter_decision_json,
      legacyAdapterDecisionForBatch(parsed)
    ),
    target: {
      sessionId: parsed.target_session_id,
      taskId: parsed.target_task_id,
      runtimeId: parsed.target_runtime_id,
      agentId: parsed.target_agent_id,
    },
    matchIds: parseJsonColumn<string[]>(
      parsed.match_ids_json,
      'project_event_delivery_batches.match_ids_json'
    ),
    eventCount: parsed.event_count,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    deliveredAt: parsed.delivered_at,
    ackedAt: parsed.acked_at,
    ackedBy: ownerFromColumns(parsed.acked_by_type, parsed.acked_by_id, parsed.acked_by_name),
    terminalAt: parsed.terminal_at,
    terminalReason: parsed.terminal_reason,
  };
}

function legacyAdapterDecisionForBatch(
  parsed: ProjectEventDeliveryBatchRow
): ProjectEventDeliveryAdapterDecision {
  return {
    action:
      parsed.resolved_delivery === 'record_only'
        ? 'record_only'
        : parsed.resolved_delivery === 'unsupported'
          ? 'unsupported'
          : parsed.resolved_delivery === 'unauthorized'
            ? 'unauthorized'
            : 'recorded_not_injected',
    reason: 'recorded_not_injected_baseline',
    adapterId: null,
    adapterKind: null,
    capability: null,
    agentType: null,
    protocol: null,
    protocolVersion: null,
    durableAck: false,
    supported: parsed.resolved_delivery !== 'unsupported',
    authorized: parsed.resolved_delivery !== 'unauthorized',
    terminal: parsed.state !== 'pending',
  };
}

export function mapProjectEventDeliveryAttempt(row: unknown): ProjectEventDeliveryAttemptRecord {
  const parsed = parseProjectEventDeliveryAttemptRow(row);
  return {
    id: parsed.id,
    projectId: parsed.project_id,
    batchId: parsed.batch_id,
    idempotencyKey: parsed.idempotency_key,
    attemptNumber: parsed.attempt_number,
    state: parsed.state,
    adapter: parsed.adapter,
    protocolVersion: parsed.protocol_version,
    runtimeId: parsed.runtime_id,
    receiptId: parsed.receipt_id,
    errorCode: parsed.error_code,
    errorMessage: parsed.error_message,
    startedAt: parsed.started_at,
    completedAt: parsed.completed_at,
    createdAt: parsed.created_at,
  };
}

export function mapProjectEventStorageAccounting(
  row: unknown
): ProjectEventStorageAccountingRecord {
  const parsed = parseProjectEventStorageAccountingRow(row);
  return {
    projectId: parsed.project_id,
    category: parsed.category,
    recordCount: parsed.record_count,
    estimatedBytes: parsed.estimated_bytes,
    oldestCreatedAt: parsed.oldest_created_at,
    newestCreatedAt: parsed.newest_created_at,
    measuredAt: parsed.measured_at,
  };
}
