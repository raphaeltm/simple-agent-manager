import {
  DEFAULT_ACP_INTERACTION_ANSWER_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_ANSWER_STRING_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_DEADLINE_MARGIN_MS,
  DEFAULT_ACP_INTERACTION_DELIVERY_WINDOW_MS,
  DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM,
  DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES,
  DEFAULT_ACP_INTERACTION_MAX_DEADLINE_MS,
  DEFAULT_ACP_INTERACTION_MAX_PENDING_PER_SESSION,
  DEFAULT_ACP_INTERACTION_OPTION_NAME_MAX_CHARS,
  DEFAULT_ACP_INTERACTION_OPTIONS_MAX_COUNT,
  DEFAULT_ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS,
  DEFAULT_ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS,
  DEFAULT_ACP_INTERACTION_REQUEST_MAX_BYTES,
  DEFAULT_ACP_INTERACTION_RETRY_DELAYS_MS,
  DEFAULT_ACP_INTERACTION_RETRY_STEADY_MS,
  DEFAULT_ACP_INTERACTION_SENSITIVE_PURGE_MS,
  DEFAULT_ACP_INTERACTION_SNAPSHOT_LAST_SETTLED,
  DEFAULT_ACP_INTERACTION_SUMMARY_LAST_SETTLED,
  DEFAULT_ACP_INTERACTION_SUMMARY_RETENTION_MS,
  DEFAULT_ACP_INTERACTIONS_ENABLED,
} from '@simple-agent-manager/shared';

export interface AcpInteractionConfigEnv {
  ACP_INTERACTIONS_ENABLED?: string;
  ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS?: string;
  ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS?: string;
  ACP_INTERACTION_MAX_DEADLINE_MS?: string;
  ACP_INTERACTION_DEADLINE_MARGIN_MS?: string;
  ACP_INTERACTION_MAX_PENDING_PER_SESSION?: string;
  ACP_INTERACTION_REQUEST_MAX_BYTES?: string;
  ACP_INTERACTION_OPTIONS_MAX_COUNT?: string;
  ACP_INTERACTION_OPTION_NAME_MAX_CHARS?: string;
  ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES?: string;
  ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES?: string;
  ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM?: string;
  ACP_INTERACTION_ANSWER_MAX_BYTES?: string;
  ACP_INTERACTION_ANSWER_STRING_MAX_BYTES?: string;
  ACP_INTERACTION_RETRY_DELAYS_MS?: string;
  ACP_INTERACTION_RETRY_STEADY_MS?: string;
  ACP_INTERACTION_DELIVERY_WINDOW_MS?: string;
  ACP_INTERACTION_SENSITIVE_PURGE_MS?: string;
  ACP_INTERACTION_SUMMARY_RETENTION_MS?: string;
  ACP_INTERACTION_SUMMARY_LAST_SETTLED?: string;
  ACP_INTERACTION_SNAPSHOT_LAST_SETTLED?: string;
}

export interface AcpInteractionConfig {
  enabled: boolean;
  permissionConversationDeadlineMs: number;
  permissionTaskDeadlineMs: number;
  maxDeadlineMs: number;
  deadlineMarginMs: number;
  maxPendingPerSession: number;
  requestMaxBytes: number;
  optionsMaxCount: number;
  optionNameMaxChars: number;
  formSchemaMaxBytes: number;
  formSchemaMaxProperties: number;
  formSchemaMaxEnum: number;
  answerMaxBytes: number;
  answerStringMaxBytes: number;
  retryDelaysMs: number[];
  retrySteadyMs: number;
  deliveryWindowMs: number;
  sensitivePurgeMs: number;
  summaryRetentionMs: number;
  summaryLastSettled: number;
  snapshotLastSettled: number;
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim().toLowerCase() === 'true';
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveIntList(value: string | undefined, fallback: readonly number[]): number[] {
  if (value === undefined || value.trim() === '') return [...fallback];
  const parsed = value
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

export function getAcpInteractionConfig(env: AcpInteractionConfigEnv): AcpInteractionConfig {
  return {
    enabled: envFlag(env.ACP_INTERACTIONS_ENABLED, DEFAULT_ACP_INTERACTIONS_ENABLED),
    permissionConversationDeadlineMs: positiveInt(
      env.ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS,
      DEFAULT_ACP_INTERACTION_PERMISSION_CONVERSATION_DEADLINE_MS
    ),
    permissionTaskDeadlineMs: positiveInt(
      env.ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS,
      DEFAULT_ACP_INTERACTION_PERMISSION_TASK_DEADLINE_MS
    ),
    maxDeadlineMs: positiveInt(
      env.ACP_INTERACTION_MAX_DEADLINE_MS,
      DEFAULT_ACP_INTERACTION_MAX_DEADLINE_MS
    ),
    deadlineMarginMs: positiveInt(
      env.ACP_INTERACTION_DEADLINE_MARGIN_MS,
      DEFAULT_ACP_INTERACTION_DEADLINE_MARGIN_MS
    ),
    maxPendingPerSession: positiveInt(
      env.ACP_INTERACTION_MAX_PENDING_PER_SESSION,
      DEFAULT_ACP_INTERACTION_MAX_PENDING_PER_SESSION
    ),
    requestMaxBytes: positiveInt(
      env.ACP_INTERACTION_REQUEST_MAX_BYTES,
      DEFAULT_ACP_INTERACTION_REQUEST_MAX_BYTES
    ),
    optionsMaxCount: positiveInt(
      env.ACP_INTERACTION_OPTIONS_MAX_COUNT,
      DEFAULT_ACP_INTERACTION_OPTIONS_MAX_COUNT
    ),
    optionNameMaxChars: positiveInt(
      env.ACP_INTERACTION_OPTION_NAME_MAX_CHARS,
      DEFAULT_ACP_INTERACTION_OPTION_NAME_MAX_CHARS
    ),
    formSchemaMaxBytes: positiveInt(
      env.ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES,
      DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_BYTES
    ),
    formSchemaMaxProperties: positiveInt(
      env.ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES,
      DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_PROPERTIES
    ),
    formSchemaMaxEnum: positiveInt(
      env.ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM,
      DEFAULT_ACP_INTERACTION_FORM_SCHEMA_MAX_ENUM
    ),
    answerMaxBytes: positiveInt(
      env.ACP_INTERACTION_ANSWER_MAX_BYTES,
      DEFAULT_ACP_INTERACTION_ANSWER_MAX_BYTES
    ),
    answerStringMaxBytes: positiveInt(
      env.ACP_INTERACTION_ANSWER_STRING_MAX_BYTES,
      DEFAULT_ACP_INTERACTION_ANSWER_STRING_MAX_BYTES
    ),
    retryDelaysMs: positiveIntList(
      env.ACP_INTERACTION_RETRY_DELAYS_MS,
      DEFAULT_ACP_INTERACTION_RETRY_DELAYS_MS
    ),
    retrySteadyMs: positiveInt(
      env.ACP_INTERACTION_RETRY_STEADY_MS,
      DEFAULT_ACP_INTERACTION_RETRY_STEADY_MS
    ),
    deliveryWindowMs: positiveInt(
      env.ACP_INTERACTION_DELIVERY_WINDOW_MS,
      DEFAULT_ACP_INTERACTION_DELIVERY_WINDOW_MS
    ),
    sensitivePurgeMs: positiveInt(
      env.ACP_INTERACTION_SENSITIVE_PURGE_MS,
      DEFAULT_ACP_INTERACTION_SENSITIVE_PURGE_MS
    ),
    summaryRetentionMs: positiveInt(
      env.ACP_INTERACTION_SUMMARY_RETENTION_MS,
      DEFAULT_ACP_INTERACTION_SUMMARY_RETENTION_MS
    ),
    summaryLastSettled: positiveInt(
      env.ACP_INTERACTION_SUMMARY_LAST_SETTLED,
      DEFAULT_ACP_INTERACTION_SUMMARY_LAST_SETTLED
    ),
    snapshotLastSettled: positiveInt(
      env.ACP_INTERACTION_SNAPSHOT_LAST_SETTLED,
      DEFAULT_ACP_INTERACTION_SNAPSHOT_LAST_SETTLED
    ),
  };
}
