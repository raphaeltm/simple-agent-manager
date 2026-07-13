import type { WebhookTriggerConfigInput } from '@simple-agent-manager/shared';
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
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';

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
  if ((config.includedHeaders?.length ?? 0) > limits.maxIncludedHeaders) {
    return `webhookConfig.includedHeaders must contain at most ${limits.maxIncludedHeaders} items`;
  }
  if (config.includedHeaders?.some((header) => header.length > limits.maxHeaderNameLength)) {
    return `Webhook header names must be at most ${limits.maxHeaderNameLength} characters`;
  }
  return null;
}
