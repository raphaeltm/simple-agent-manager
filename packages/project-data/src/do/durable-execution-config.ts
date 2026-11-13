import {
  DEFAULT_ACP_CHECKPOINT_PREEMPT_GRACE_MS,
  DEFAULT_ACP_LONG_TURN_CHECKPOINT_MS,
  DEFAULT_ACP_LONG_TURN_SUPERVISOR_ENABLED,
  DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED,
  DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS,
  DEFAULT_PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED,
  DEFAULT_PROMPT_DELIVERY_MAX_ATTEMPTS,
  DEFAULT_PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM,
  DEFAULT_PROMPT_DELIVERY_MIN_ALARM_DELAY_MS,
  DEFAULT_PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS,
  DEFAULT_PROMPT_DELIVERY_RETRY_BASE_MS,
  DEFAULT_PROMPT_DELIVERY_RETRY_MAX_MS,
  DEFAULT_PROMPT_DELIVERY_TTL_MS,
} from '@simple-agent-manager/shared';

import type { Env } from './types';

export interface DurableExecutionConfig {
  deliveryEnabled: boolean;
  legacyVmCompatEnabled: boolean;
  supervisorEnabled: boolean;
  checkpointThresholdMs: number;
  preemptGraceMs: number;
  maxCandidatesPerAlarm: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  ttlMs: number;
  receiptTimeoutMs: number;
  backgroundTimeoutMs: number;
  minAlarmDelayMs: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected boolean environment value, received ${JSON.stringify(value)}`);
}

function parsePositive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function resolveDurableExecutionConfig(env: Env): DurableExecutionConfig {
  const config: DurableExecutionConfig = {
    deliveryEnabled: parseBoolean(
      env.DURABLE_PROMPT_DELIVERY_ENABLED,
      DEFAULT_DURABLE_PROMPT_DELIVERY_ENABLED,
    ),
    legacyVmCompatEnabled: parseBoolean(
      env.PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED,
      DEFAULT_PROMPT_DELIVERY_LEGACY_VM_COMPAT_ENABLED,
    ),
    supervisorEnabled: parseBoolean(
      env.ACP_LONG_TURN_SUPERVISOR_ENABLED,
      DEFAULT_ACP_LONG_TURN_SUPERVISOR_ENABLED,
    ),
    checkpointThresholdMs: parsePositive(
      env.ACP_LONG_TURN_CHECKPOINT_MS,
      DEFAULT_ACP_LONG_TURN_CHECKPOINT_MS,
      'ACP_LONG_TURN_CHECKPOINT_MS',
    ),
    preemptGraceMs: parsePositive(
      env.ACP_CHECKPOINT_PREEMPT_GRACE_MS,
      DEFAULT_ACP_CHECKPOINT_PREEMPT_GRACE_MS,
      'ACP_CHECKPOINT_PREEMPT_GRACE_MS',
    ),
    maxCandidatesPerAlarm: parsePositive(
      env.PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM,
      DEFAULT_PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM,
      'PROMPT_DELIVERY_MAX_CANDIDATES_PER_ALARM',
    ),
    maxAttempts: parsePositive(
      env.PROMPT_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_PROMPT_DELIVERY_MAX_ATTEMPTS,
      'PROMPT_DELIVERY_MAX_ATTEMPTS',
    ),
    retryBaseMs: parsePositive(
      env.PROMPT_DELIVERY_RETRY_BASE_MS,
      DEFAULT_PROMPT_DELIVERY_RETRY_BASE_MS,
      'PROMPT_DELIVERY_RETRY_BASE_MS',
    ),
    retryMaxMs: parsePositive(
      env.PROMPT_DELIVERY_RETRY_MAX_MS,
      DEFAULT_PROMPT_DELIVERY_RETRY_MAX_MS,
      'PROMPT_DELIVERY_RETRY_MAX_MS',
    ),
    ttlMs: parsePositive(
      env.PROMPT_DELIVERY_TTL_MS,
      DEFAULT_PROMPT_DELIVERY_TTL_MS,
      'PROMPT_DELIVERY_TTL_MS',
    ),
    receiptTimeoutMs: parsePositive(
      env.PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS,
      DEFAULT_PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS,
      'PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS',
    ),
    backgroundTimeoutMs: parsePositive(
      env.PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS,
      DEFAULT_PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS,
      'PROMPT_DELIVERY_BACKGROUND_TIMEOUT_MS',
    ),
    minAlarmDelayMs: parsePositive(
      env.PROMPT_DELIVERY_MIN_ALARM_DELAY_MS,
      DEFAULT_PROMPT_DELIVERY_MIN_ALARM_DELAY_MS,
      'PROMPT_DELIVERY_MIN_ALARM_DELAY_MS',
    ),
  };

  if (config.retryBaseMs > config.retryMaxMs) {
    throw new Error('PROMPT_DELIVERY_RETRY_BASE_MS must be <= PROMPT_DELIVERY_RETRY_MAX_MS');
  }
  if (config.receiptTimeoutMs >= config.ttlMs) {
    throw new Error('PROMPT_DELIVERY_RECEIPT_TIMEOUT_MS must be < PROMPT_DELIVERY_TTL_MS');
  }
  return config;
}

export function promptDeliveryBackoffMs(
  attemptCount: number,
  config: Pick<DurableExecutionConfig, 'retryBaseMs' | 'retryMaxMs'>,
): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 30));
  return Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** exponent);
}
