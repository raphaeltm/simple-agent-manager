/** Default advisory warning threshold for credential provider quota windows. */
export const DEFAULT_CREDENTIAL_LIMIT_WARNING_PERCENT = 75;

/** Default advisory critical threshold for credential provider quota windows. */
export const DEFAULT_CREDENTIAL_LIMIT_CRITICAL_PERCENT = 90;

/** Canonical source for internally produced credential-limit project events. */
export const CREDENTIAL_LIMIT_EVENT_SOURCE = 'sam.credential_limit';

/** Canonical event type names for credential-limit edge transitions. */
export const CREDENTIAL_LIMIT_EVENT_TYPES = {
  warning: 'credential.limit.warning',
  critical: 'credential.limit.critical',
  rejected: 'credential.limit.rejected',
  reset: 'credential.limit.reset',
} as const;

/** Provider identifiers accepted from credential-limit telemetry. */
export const DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_PROVIDERS = ['anthropic', 'openai'] as const;

/** Source identifiers accepted from credential-limit telemetry. */
export const DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_SOURCES = [
  'ai-proxy.anthropic.chat_completions',
  'ai-proxy.openai.chat_completions',
  'ai-proxy.openai.responses',
  'ai-proxy-anthropic.count_tokens',
  'ai-proxy-anthropic.messages',
  'ai-proxy-passthrough.anthropic.count_tokens',
  'ai-proxy-passthrough.anthropic.messages',
  'ai-proxy-passthrough.openai.chat_completions',
  'claude-acp.rate_limit',
  'claude-acp.usage_update',
  'vm-agent.acp_usage_update',
] as const;

/** Window identifiers accepted from credential-limit telemetry. */
export const DEFAULT_CREDENTIAL_LIMIT_SUPPORTED_WINDOW_TYPES = [
  'anthropic.input-tokens',
  'anthropic.output-tokens',
  'anthropic.priority-input-tokens',
  'anthropic.priority-output-tokens',
  'anthropic.requests',
  'anthropic.tokens',
  'claude.five_hour',
  'claude.seven_day',
  'openai.project-tokens',
  'openai.requests',
  'openai.tokens',
] as const;

/** Maximum credential-limit observations accepted from one usage callback/report. */
export const DEFAULT_CREDENTIAL_LIMIT_MAX_OBSERVATIONS_PER_REPORT = 16;

/** Maximum raw JSON request body accepted for one VM usage callback. */
export const DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_MAX_BODY_BYTES = 32 * 1024;

/** Default authenticated VM usage callback limit per session per minute. */
export const DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_RPM = 120;

/** Default authenticated VM usage callback rate limit window in seconds. */
export const DEFAULT_CREDENTIAL_LIMIT_USAGE_CALLBACK_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Maximum accepted sample age for credential-limit observations. */
export const DEFAULT_CREDENTIAL_LIMIT_OBSERVATION_MAX_AGE_MS = 24 * 60 * 60_000;

/** Maximum accepted future clock skew for credential-limit observation times. */
export const DEFAULT_CREDENTIAL_LIMIT_OBSERVATION_FUTURE_SKEW_MS = 5 * 60_000;

/** Maximum accepted future provider reset timestamp. */
export const DEFAULT_CREDENTIAL_LIMIT_RESET_MAX_FUTURE_MS = 8 * 24 * 60 * 60_000;

/** Maximum credential-limit admission envelopes retained per project. */
export const DEFAULT_CREDENTIAL_LIMIT_ADMISSION_MAX_ACTIVE_PER_PROJECT = 1_000;

/** Maximum pending credential-limit admission envelopes retried opportunistically. */
export const DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETRY_BATCH_SIZE = 25;

/** Retention for credential-limit admission/outbox rows. */
export const DEFAULT_CREDENTIAL_LIMIT_ADMISSION_RETENTION_DAYS = 30;
