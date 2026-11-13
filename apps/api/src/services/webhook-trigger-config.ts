import type {
  WebhookTriggerConfigInput,
  WebhookVerificationConfig,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE,
  DEFAULT_WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE,
  DEFAULT_WEBHOOK_DELIVERY_MAX_PAGE_SIZE,
  DEFAULT_WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS,
  DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
  DEFAULT_WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE,
  DEFAULT_WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE,
  DEFAULT_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_WEBHOOK_TRIGGER_MAX_BODY_BYTES,
  DEFAULT_WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_FILTERS,
  DEFAULT_WEBHOOK_TRIGGER_MAX_HEADER_NAME_LENGTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS,
  DEFAULT_WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH,
  DEFAULT_WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE,
  isWebhookSignedScheme,
  SLACK_WEBHOOK_DEFAULTS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { errors } from '../middleware/error';
import { resolveAdminSettingDetailsMany } from './admin-settings';

export interface WebhookTriggerLimits {
  maxBodyBytes: number;
  maxFilters: number;
  maxFilterPathLength: number;
  maxFilterPathDepth: number;
  maxIncludedHeaders: number;
  maxHeaderNameLength: number;
  maxSourceLabelLength: number;
  maxIdempotencyKeyLength: number;
  deliveryRetentionDays: number;
  deliveryCleanupBatchSize: number;
  deliveryDefaultPageSize: number;
  deliveryMaxPageSize: number;
  deliveryProcessingLeaseSeconds: number;
  triggerRateLimit: number;
  invalidTokenRateLimit: number;
  ingressRateLimit: number;
  rateLimitWindowSeconds: number;
}

export function areWebhookTriggersEnabled(env: Env): boolean {
  return env.WEBHOOK_TRIGGERS_ENABLED?.toLowerCase() !== 'false';
}

export function getWebhookTriggerLimits(env: Env): WebhookTriggerLimits {
  return {
    maxBodyBytes: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_BODY_BYTES,
      DEFAULT_WEBHOOK_TRIGGER_MAX_BODY_BYTES
    ),
    maxFilters: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_FILTERS,
      DEFAULT_WEBHOOK_TRIGGER_MAX_FILTERS
    ),
    maxFilterPathLength: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH,
      DEFAULT_WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH
    ),
    maxFilterPathDepth: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH,
      DEFAULT_WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH
    ),
    maxIncludedHeaders: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS,
      DEFAULT_WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS
    ),
    maxHeaderNameLength: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_HEADER_NAME_LENGTH,
      DEFAULT_WEBHOOK_TRIGGER_MAX_HEADER_NAME_LENGTH
    ),
    maxSourceLabelLength: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH,
      DEFAULT_WEBHOOK_TRIGGER_MAX_SOURCE_LABEL_LENGTH
    ),
    maxIdempotencyKeyLength: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH,
      DEFAULT_WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH
    ),
    deliveryRetentionDays: parsePositiveInt(
      env.WEBHOOK_DELIVERY_RETENTION_DAYS,
      DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS
    ),
    deliveryCleanupBatchSize: parsePositiveInt(
      env.WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE,
      DEFAULT_WEBHOOK_DELIVERY_CLEANUP_BATCH_SIZE
    ),
    deliveryDefaultPageSize: parsePositiveInt(
      env.WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE,
      DEFAULT_WEBHOOK_DELIVERY_DEFAULT_PAGE_SIZE
    ),
    deliveryMaxPageSize: parsePositiveInt(
      env.WEBHOOK_DELIVERY_MAX_PAGE_SIZE,
      DEFAULT_WEBHOOK_DELIVERY_MAX_PAGE_SIZE
    ),
    deliveryProcessingLeaseSeconds: parsePositiveInt(
      env.WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS,
      DEFAULT_WEBHOOK_DELIVERY_PROCESSING_LEASE_SECONDS
    ),
    triggerRateLimit: parsePositiveInt(
      env.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE,
      DEFAULT_WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE
    ),
    invalidTokenRateLimit: parsePositiveInt(
      env.WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE,
      DEFAULT_WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE
    ),
    ingressRateLimit: parsePositiveInt(
      env.WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE,
      DEFAULT_WEBHOOK_INGRESS_RATE_LIMIT_PER_MINUTE
    ),
    rateLimitWindowSeconds: parsePositiveInt(
      env.WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS
    ),
  };
}

export function validateWebhookTriggerConfig(
  config: WebhookTriggerConfigInput,
  limits: WebhookTriggerLimits
): string | null {
  const filters = config.filters ?? [];
  if ((config.sourceLabel?.length ?? 0) > limits.maxSourceLabelLength) {
    return `webhookConfig.sourceLabel must be at most ${limits.maxSourceLabelLength} characters`;
  }
  if (filters.length > limits.maxFilters) {
    return `webhookConfig.filters must contain at most ${limits.maxFilters} items`;
  }
  for (const filter of filters) {
    if (filter.path.length > limits.maxFilterPathLength) {
      return `Webhook filter paths must be at most ${limits.maxFilterPathLength} characters`;
    }
    if (filter.path.split('.').length > limits.maxFilterPathDepth) {
      return `Webhook filter paths must contain at most ${limits.maxFilterPathDepth} segments`;
    }
  }
  const schemeError = validateWebhookVerification(config, limits);
  if (schemeError) return schemeError;
  if ((config.includedHeaders?.length ?? 0) > limits.maxIncludedHeaders) {
    return `webhookConfig.includedHeaders must contain at most ${limits.maxIncludedHeaders} items`;
  }
  if (config.includedHeaders?.some((header) => header.length > limits.maxHeaderNameLength)) {
    return `Webhook header names must be at most ${limits.maxHeaderNameLength} characters`;
  }
  return null;
}

/** Scheme-specific rules: a signed automation must say where the sender's event ID is. */
function validateWebhookVerification(
  config: WebhookTriggerConfigInput,
  limits: WebhookTriggerLimits
): string | null {
  const verification = config.verification ?? { scheme: 'sam_bearer' };
  const eventId = config.eventId;
  if (!isWebhookSignedScheme(verification.scheme)) {
    return eventId
      ? 'webhookConfig.eventId applies to signed schemes; token webhooks use the Idempotency-Key header'
      : null;
  }
  if (verification.scheme === 'hmac_sha256_body') {
    if (verification.header.length > limits.maxHeaderNameLength) {
      return `Webhook header names must be at most ${limits.maxHeaderNameLength} characters`;
    }
    const signatureHeader = verification.header.toLowerCase();
    if (config.includedHeaders?.some((name) => name.trim().toLowerCase() === signatureHeader)) {
      return 'webhookConfig.includedHeaders cannot contain the signature header';
    }
  }
  if (!eventId) {
    return 'webhookConfig.eventId is required for signed schemes: name the header or body path that carries the sender’s event ID';
  }
  if ('header' in eventId) {
    return eventId.header.length > limits.maxHeaderNameLength
      ? `Webhook header names must be at most ${limits.maxHeaderNameLength} characters`
      : null;
  }
  if (eventId.path.length > limits.maxFilterPathLength) {
    return `webhookConfig.eventId.path must be at most ${limits.maxFilterPathLength} characters`;
  }
  if (eventId.path.split('.').length > limits.maxFilterPathDepth) {
    return `webhookConfig.eventId.path must contain at most ${limits.maxFilterPathDepth} segments`;
  }
  return null;
}

/**
 * What a scheme fills in when the caller leaves it out. For Slack that is where its event ID is
 * and the two conditions that start a run only for a mention that did not come from a bot (the
 * loop guard). Both stay editable afterwards.
 */
export function applyWebhookSchemeDefaults(
  config: WebhookTriggerConfigInput
): WebhookTriggerConfigInput {
  if (config.verification?.scheme !== 'slack_v0') return config;
  return {
    ...config,
    eventId: config.eventId ?? SLACK_WEBHOOK_DEFAULTS.eventId,
    filterMode: config.filterMode ?? (config.filters ? 'all' : SLACK_WEBHOOK_DEFAULTS.filterMode),
    filters: config.filters ?? SLACK_WEBHOOK_DEFAULTS.filters.map((filter) => ({ ...filter })),
  };
}

/** The scheme decides the address and what the stored secret means, so it is fixed at creation. */
export function assertWebhookSchemeUnchanged(
  stored: WebhookVerificationConfig,
  requested: WebhookVerificationConfig | undefined
): void {
  if (!requested) return;
  const sameHeader =
    stored.scheme !== 'hmac_sha256_body' ||
    (requested.scheme === 'hmac_sha256_body' && requested.header === stored.header);
  if (requested.scheme !== stored.scheme || !sameHeader) {
    throw errors.badRequest(
      'The verification scheme cannot be changed after creation. Create a new automation instead.'
    );
  }
}

export interface WebhookQueueSettings {
  /** Most live waiting events one signed automation may hold. */
  maxPending: number;
  /** Seconds an event may wait for a free run before it is dropped. */
  ttlSeconds: number;
  /** Allowed clock difference for schemes that sign a timestamp. */
  signatureToleranceSeconds: number;
}

/** Admin-editable limits for signed webhook intake (cached per isolate by the settings store). */
export async function getWebhookQueueSettings(env: Env): Promise<WebhookQueueSettings> {
  const [pending, ttl, tolerance] = await resolveAdminSettingDetailsMany(env, [
    'operations.webhookQueueMaxPending',
    'operations.webhookQueueTtlSeconds',
    'operations.webhookSignatureToleranceSeconds',
  ]);
  if (!pending || !ttl || !tolerance) throw errors.internal('Webhook queue limits are unavailable');
  return {
    maxPending: Number(pending.value),
    ttlSeconds: Number(ttl.value),
    signatureToleranceSeconds: Number(tolerance.value),
  };
}
