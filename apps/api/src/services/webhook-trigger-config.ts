import type { WebhookTriggerConfigInput } from '@simple-agent-manager/shared';
import {
  DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
  DEFAULT_WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE,
  DEFAULT_WEBHOOK_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_WEBHOOK_TRIGGER_MAX_BODY_BYTES,
  DEFAULT_WEBHOOK_TRIGGER_MAX_FILTER_PATH_DEPTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_FILTER_PATH_LENGTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_FILTERS,
  DEFAULT_WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH,
  DEFAULT_WEBHOOK_TRIGGER_MAX_INCLUDED_HEADERS,
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
  maxIdempotencyKeyLength: number;
  deliveryRetentionDays: number;
  triggerRateLimit: number;
  invalidTokenRateLimit: number;
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
    maxIdempotencyKeyLength: parsePositiveInt(
      env.WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH,
      DEFAULT_WEBHOOK_TRIGGER_MAX_IDEMPOTENCY_KEY_LENGTH
    ),
    deliveryRetentionDays: parsePositiveInt(
      env.WEBHOOK_DELIVERY_RETENTION_DAYS,
      DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS
    ),
    triggerRateLimit: parsePositiveInt(
      env.WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE,
      DEFAULT_WEBHOOK_TRIGGER_RATE_LIMIT_PER_MINUTE
    ),
    invalidTokenRateLimit: parsePositiveInt(
      env.WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE,
      DEFAULT_WEBHOOK_INVALID_TOKEN_RATE_LIMIT_PER_MINUTE
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
  return null;
}
