import {
  PROJECT_EVENT_DELIVERY_ATTEMPT_STATES,
  PROJECT_EVENT_DELIVERY_BATCH_STATES,
  PROJECT_EVENT_REQUESTED_DELIVERY_MODES,
  PROJECT_EVENT_RESOLVED_DELIVERY_MODES,
  PROJECT_EVENT_SEVERITIES,
  PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES,
  PROJECT_EVENT_SUBSCRIPTION_STATES,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import { parseRow } from './core';

export const ProjectEventRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  contract_version: v.number(),
  source: v.string(),
  event_type: v.string(),
  subject_type: v.string(),
  subject_id: v.string(),
  severity: v.picklist(PROJECT_EVENT_SEVERITIES),
  delivery_key: v.string(),
  payload_fingerprint: v.string(),
  metadata_json: v.string(),
  display_json: v.string(),
  raw_payload_ref_json: v.nullable(v.string()),
  occurred_at: v.number(),
  received_at: v.number(),
  updated_at: v.number(),
  state: v.picklist(['recorded', 'conflicted'] as const),
  duplicate_count: v.number(),
  conflict_count: v.number(),
  conflict_fingerprint: v.nullable(v.string()),
  conflict_detected_at: v.nullable(v.number()),
});

export const ProjectEventSubscriptionRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  contract_version: v.number(),
  owner_type: v.picklist(PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES),
  owner_id: v.string(),
  owner_name: v.nullable(v.string()),
  idempotency_key: v.string(),
  idempotency_fingerprint: v.string(),
  filter_version: v.number(),
  filter_json: v.string(),
  filter_fingerprint: v.string(),
  match_key_count: v.number(),
  requested_delivery: v.picklist(PROJECT_EVENT_REQUESTED_DELIVERY_MODES),
  resolved_delivery: v.picklist(PROJECT_EVENT_RESOLVED_DELIVERY_MODES),
  target_session_id: v.nullable(v.string()),
  target_task_id: v.nullable(v.string()),
  target_runtime_id: v.nullable(v.string()),
  target_agent_id: v.nullable(v.string()),
  lifecycle_state: v.picklist(PROJECT_EVENT_SUBSCRIPTION_STATES),
  reason: v.nullable(v.string()),
  created_at: v.number(),
  updated_at: v.number(),
  expires_at: v.nullable(v.number()),
  cancelled_at: v.nullable(v.number()),
  cancelled_by_type: v.nullable(v.picklist(PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES)),
  cancelled_by_id: v.nullable(v.string()),
  cancelled_by_name: v.nullable(v.string()),
  cancel_reason: v.nullable(v.string()),
  last_matched_at: v.nullable(v.number()),
});

export const ProjectEventMatchRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  event_id: v.string(),
  subscription_id: v.string(),
  state: v.picklist([
    'matched',
    'batch_created',
    'recorded_not_injected',
    'expired',
    'cancelled',
  ] as const),
  matched_at: v.number(),
  lifecycle_checked_at: v.number(),
  batch_id: v.nullable(v.string()),
  reason: v.nullable(v.string()),
});

export const ProjectEventDeliveryBatchRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  subscription_id: v.string(),
  idempotency_key: v.string(),
  ack_required: v.number(),
  state: v.picklist(PROJECT_EVENT_DELIVERY_BATCH_STATES),
  requested_delivery: v.picklist(PROJECT_EVENT_REQUESTED_DELIVERY_MODES),
  resolved_delivery: v.picklist(PROJECT_EVENT_RESOLVED_DELIVERY_MODES),
  adapter_decision_json: v.nullable(v.string()),
  target_session_id: v.nullable(v.string()),
  target_task_id: v.nullable(v.string()),
  target_runtime_id: v.nullable(v.string()),
  target_agent_id: v.nullable(v.string()),
  match_ids_json: v.string(),
  event_count: v.number(),
  created_at: v.number(),
  updated_at: v.number(),
  delivered_at: v.nullable(v.number()),
  acked_at: v.nullable(v.number()),
  acked_by_type: v.nullable(v.picklist(PROJECT_EVENT_SUBSCRIPTION_OWNER_TYPES)),
  acked_by_id: v.nullable(v.string()),
  acked_by_name: v.nullable(v.string()),
  terminal_at: v.nullable(v.number()),
  terminal_reason: v.nullable(v.string()),
});

export const ProjectEventDeliveryAttemptRowSchema = v.object({
  id: v.string(),
  project_id: v.string(),
  batch_id: v.string(),
  idempotency_key: v.string(),
  attempt_number: v.number(),
  state: v.picklist(PROJECT_EVENT_DELIVERY_ATTEMPT_STATES),
  adapter: v.nullable(v.string()),
  protocol_version: v.nullable(v.string()),
  runtime_id: v.nullable(v.string()),
  receipt_id: v.nullable(v.string()),
  error_code: v.nullable(v.string()),
  error_message: v.nullable(v.string()),
  started_at: v.number(),
  completed_at: v.nullable(v.number()),
  created_at: v.number(),
});

export const ProjectEventStorageAccountingRowSchema = v.object({
  project_id: v.string(),
  category: v.string(),
  record_count: v.number(),
  estimated_bytes: v.number(),
  oldest_created_at: v.nullable(v.number()),
  newest_created_at: v.nullable(v.number()),
  measured_at: v.number(),
});

export type ProjectEventRow = v.InferOutput<typeof ProjectEventRowSchema>;
export type ProjectEventSubscriptionRow = v.InferOutput<typeof ProjectEventSubscriptionRowSchema>;
export type ProjectEventMatchRow = v.InferOutput<typeof ProjectEventMatchRowSchema>;
export type ProjectEventDeliveryBatchRow = v.InferOutput<typeof ProjectEventDeliveryBatchRowSchema>;
export type ProjectEventDeliveryAttemptRow = v.InferOutput<
  typeof ProjectEventDeliveryAttemptRowSchema
>;
export type ProjectEventStorageAccountingRow = v.InferOutput<
  typeof ProjectEventStorageAccountingRowSchema
>;

export function parseProjectEventRow(row: unknown): ProjectEventRow {
  return parseRow(ProjectEventRowSchema, row, 'project_event');
}

export function parseProjectEventSubscriptionRow(row: unknown): ProjectEventSubscriptionRow {
  return parseRow(ProjectEventSubscriptionRowSchema, row, 'project_event_subscription');
}

export function parseProjectEventMatchRow(row: unknown): ProjectEventMatchRow {
  return parseRow(ProjectEventMatchRowSchema, row, 'project_event_match');
}

export function parseProjectEventDeliveryBatchRow(row: unknown): ProjectEventDeliveryBatchRow {
  return parseRow(ProjectEventDeliveryBatchRowSchema, row, 'project_event_delivery_batch');
}

export function parseProjectEventDeliveryAttemptRow(row: unknown): ProjectEventDeliveryAttemptRow {
  return parseRow(ProjectEventDeliveryAttemptRowSchema, row, 'project_event_delivery_attempt');
}

export function parseProjectEventStorageAccountingRow(
  row: unknown
): ProjectEventStorageAccountingRow {
  return parseRow(ProjectEventStorageAccountingRowSchema, row, 'project_event_storage_accounting');
}
