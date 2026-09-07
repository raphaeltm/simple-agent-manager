import {
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_PROCESSING_LEASE_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_SWEEP_WALL_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_RETENTION_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TTL_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';

export interface ProjectEventSourceOutboxConfig {
  batchRows: number;
  maxAttempts: number;
  ttlMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  processingLeaseMs: number;
  sweepWallMs: number;
  admissionTimeoutMs: number;
  terminalRetentionMs: number;
}

function parsePositiveInteger(value: string | undefined, fallback: number, min = 1): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function resolveProjectEventSourceOutboxConfig(env: Env): ProjectEventSourceOutboxConfig {
  return {
    batchRows: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS
    ),
    maxAttempts: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_MAX_ATTEMPTS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_MAX_ATTEMPTS
    ),
    ttlMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_TTL_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TTL_MS
    ),
    retryBaseMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS
    ),
    retryMaxMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS
    ),
    processingLeaseMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_PROCESSING_LEASE_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_PROCESSING_LEASE_MS
    ),
    sweepWallMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_SWEEP_WALL_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_SWEEP_WALL_MS
    ),
    admissionTimeoutMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS
    ),
    terminalRetentionMs: parsePositiveInteger(
      env.PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_RETENTION_MS,
      DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_RETENTION_MS,
      0
    ),
  };
}
