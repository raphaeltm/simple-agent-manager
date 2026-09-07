import {
  DEFAULT_PROJECT_EVENT_LIMITS,
  type ProjectEventLimits,
} from '@simple-agent-manager/shared';

import { ProjectEventValidationError } from './project-events-contracts';
import type { Env } from './types';

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  min = 1
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new ProjectEventValidationError(`${field} must be an integer >= ${min}`);
  }
  return parsed;
}

export function resolveProjectEventLimits(env: Env): ProjectEventLimits {
  return {
    maxActiveSubscriptionsPerProject: parsePositiveInteger(
      env.PROJECT_EVENT_MAX_ACTIVE_SUBSCRIPTIONS_PER_PROJECT,
      DEFAULT_PROJECT_EVENT_LIMITS.maxActiveSubscriptionsPerProject,
      'PROJECT_EVENT_MAX_ACTIVE_SUBSCRIPTIONS_PER_PROJECT'
    ),
    maxFilterValuesPerField: parsePositiveInteger(
      env.PROJECT_EVENT_FILTER_MAX_VALUES_PER_FIELD,
      DEFAULT_PROJECT_EVENT_LIMITS.maxFilterValuesPerField,
      'PROJECT_EVENT_FILTER_MAX_VALUES_PER_FIELD'
    ),
    maxFilterMatchKeysPerSubscription: parsePositiveInteger(
      env.PROJECT_EVENT_FILTER_MAX_MATCH_KEYS,
      DEFAULT_PROJECT_EVENT_LIMITS.maxFilterMatchKeysPerSubscription,
      'PROJECT_EVENT_FILTER_MAX_MATCH_KEYS'
    ),
    maxFilterStringBytes: parsePositiveInteger(
      env.PROJECT_EVENT_FILTER_MAX_STRING_BYTES,
      DEFAULT_PROJECT_EVENT_LIMITS.maxFilterStringBytes,
      'PROJECT_EVENT_FILTER_MAX_STRING_BYTES'
    ),
    maxMetadataBytes: parsePositiveInteger(
      env.PROJECT_EVENT_METADATA_MAX_BYTES,
      DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataBytes,
      'PROJECT_EVENT_METADATA_MAX_BYTES'
    ),
    maxMetadataDepth: parsePositiveInteger(
      env.PROJECT_EVENT_METADATA_MAX_DEPTH,
      DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataDepth,
      'PROJECT_EVENT_METADATA_MAX_DEPTH'
    ),
    maxMetadataKeys: parsePositiveInteger(
      env.PROJECT_EVENT_METADATA_MAX_KEYS,
      DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataKeys,
      'PROJECT_EVENT_METADATA_MAX_KEYS'
    ),
    maxMetadataArrayItems: parsePositiveInteger(
      env.PROJECT_EVENT_METADATA_MAX_ARRAY_ITEMS,
      DEFAULT_PROJECT_EVENT_LIMITS.maxMetadataArrayItems,
      'PROJECT_EVENT_METADATA_MAX_ARRAY_ITEMS'
    ),
    maxDisplayBytes: parsePositiveInteger(
      env.PROJECT_EVENT_DISPLAY_MAX_BYTES,
      DEFAULT_PROJECT_EVENT_LIMITS.maxDisplayBytes,
      'PROJECT_EVENT_DISPLAY_MAX_BYTES'
    ),
    maxDisplayLabels: parsePositiveInteger(
      env.PROJECT_EVENT_DISPLAY_MAX_LABELS,
      DEFAULT_PROJECT_EVENT_LIMITS.maxDisplayLabels,
      'PROJECT_EVENT_DISPLAY_MAX_LABELS'
    ),
    maxRawPayloadRefBytes: parsePositiveInteger(
      env.PROJECT_EVENT_RAW_PAYLOAD_REF_MAX_BYTES,
      DEFAULT_PROJECT_EVENT_LIMITS.maxRawPayloadRefBytes,
      'PROJECT_EVENT_RAW_PAYLOAD_REF_MAX_BYTES'
    ),
    maxReasonBytes: parsePositiveInteger(
      env.PROJECT_EVENT_REASON_MAX_BYTES,
      DEFAULT_PROJECT_EVENT_LIMITS.maxReasonBytes,
      'PROJECT_EVENT_REASON_MAX_BYTES'
    ),
    maxMatchesPerEvent: parsePositiveInteger(
      env.PROJECT_EVENT_MAX_MATCHES_PER_EVENT,
      DEFAULT_PROJECT_EVENT_LIMITS.maxMatchesPerEvent,
      'PROJECT_EVENT_MAX_MATCHES_PER_EVENT'
    ),
    maxDeliveryBatchEvents: parsePositiveInteger(
      env.PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS,
      DEFAULT_PROJECT_EVENT_LIMITS.maxDeliveryBatchEvents,
      'PROJECT_EVENT_DELIVERY_BATCH_MAX_EVENTS'
    ),
    maxAttemptsPerBatch: parsePositiveInteger(
      env.PROJECT_EVENT_DELIVERY_ATTEMPT_MAX_PER_BATCH,
      DEFAULT_PROJECT_EVENT_LIMITS.maxAttemptsPerBatch,
      'PROJECT_EVENT_DELIVERY_ATTEMPT_MAX_PER_BATCH'
    ),
    listLimitDefault: parsePositiveInteger(
      env.PROJECT_EVENT_LIST_LIMIT,
      DEFAULT_PROJECT_EVENT_LIMITS.listLimitDefault,
      'PROJECT_EVENT_LIST_LIMIT'
    ),
    listLimitMax: parsePositiveInteger(
      env.PROJECT_EVENT_LIST_MAX,
      DEFAULT_PROJECT_EVENT_LIMITS.listLimitMax,
      'PROJECT_EVENT_LIST_MAX'
    ),
    subscriptionEventCursorMaxLength: parsePositiveInteger(
      env.PROJECT_EVENT_SUBSCRIPTION_EVENT_CURSOR_MAX_LENGTH,
      DEFAULT_PROJECT_EVENT_LIMITS.subscriptionEventCursorMaxLength,
      'PROJECT_EVENT_SUBSCRIPTION_EVENT_CURSOR_MAX_LENGTH'
    ),
    recentStatusLimit: parsePositiveInteger(
      env.PROJECT_EVENT_RECENT_STATUS_LIMIT,
      DEFAULT_PROJECT_EVENT_LIMITS.recentStatusLimit,
      'PROJECT_EVENT_RECENT_STATUS_LIMIT'
    ),
    retentionDays: parsePositiveInteger(
      env.PROJECT_EVENT_RETENTION_DAYS,
      DEFAULT_PROJECT_EVENT_LIMITS.retentionDays,
      'PROJECT_EVENT_RETENTION_DAYS',
      0
    ),
    retentionBatchRows: parsePositiveInteger(
      env.PROJECT_EVENT_RETENTION_BATCH_ROWS,
      DEFAULT_PROJECT_EVENT_LIMITS.retentionBatchRows,
      'PROJECT_EVENT_RETENTION_BATCH_ROWS'
    ),
    retentionIntervalMs: parsePositiveInteger(
      env.PROJECT_EVENT_RETENTION_INTERVAL_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.retentionIntervalMs,
      'PROJECT_EVENT_RETENTION_INTERVAL_MS'
    ),
    retentionMinAlarmDelayMs: parsePositiveInteger(
      env.PROJECT_EVENT_RETENTION_MIN_ALARM_DELAY_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.retentionMinAlarmDelayMs,
      'PROJECT_EVENT_RETENTION_MIN_ALARM_DELAY_MS'
    ),
    wakeMaterializationMinAlarmDelayMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_MATERIALIZATION_MIN_ALARM_DELAY_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeMaterializationMinAlarmDelayMs,
      'PROJECT_EVENT_WAKE_MATERIALIZATION_MIN_ALARM_DELAY_MS'
    ),
    wakeMaterializationBackoffBaseMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_MATERIALIZATION_BACKOFF_BASE_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeMaterializationBackoffBaseMs,
      'PROJECT_EVENT_WAKE_MATERIALIZATION_BACKOFF_BASE_MS'
    ),
    wakeMaterializationBackoffMaxMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_MATERIALIZATION_BACKOFF_MAX_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeMaterializationBackoffMaxMs,
      'PROJECT_EVENT_WAKE_MATERIALIZATION_BACKOFF_MAX_MS'
    ),
    wakePromptTtlMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_PROMPT_TTL_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakePromptTtlMs,
      'PROJECT_EVENT_WAKE_PROMPT_TTL_MS'
    ),
    wakeReadGraceMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_READ_GRACE_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeReadGraceMs,
      'PROJECT_EVENT_WAKE_READ_GRACE_MS'
    ),
    wakeTargetCooldownMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_TARGET_COOLDOWN_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeTargetCooldownMs,
      'PROJECT_EVENT_WAKE_TARGET_COOLDOWN_MS'
    ),
    wakeSubscriptionCooldownMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_SUBSCRIPTION_COOLDOWN_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeSubscriptionCooldownMs,
      'PROJECT_EVENT_WAKE_SUBSCRIPTION_COOLDOWN_MS'
    ),
    wakeSubscriptionLifetimeMs: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_SUBSCRIPTION_LIFETIME_MS,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeSubscriptionLifetimeMs,
      'PROJECT_EVENT_WAKE_SUBSCRIPTION_LIFETIME_MS'
    ),
    wakeMaxPerSubscription: parsePositiveInteger(
      env.PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION,
      DEFAULT_PROJECT_EVENT_LIMITS.wakeMaxPerSubscription,
      'PROJECT_EVENT_WAKE_MAX_PER_SUBSCRIPTION'
    ),
  };
}
