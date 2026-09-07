import type { ProjectEventAdmissionOutcome } from '@simple-agent-manager/shared';
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

export const PROJECT_EVENT_SOURCE_OUTBOX_ACTIVE_STATES = [
  'pending',
  'retryable_failed',
  'processing',
] as const;
export const PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_STATES = [
  'admitted',
  'expired',
  'permanent_failed',
] as const;

export class ProjectEventSourceAdmissionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ProjectData admission timed out after ${timeoutMs}ms`);
    this.name = 'ProjectEventSourceAdmissionTimeoutError';
  }
}

export type ProjectEventSourceOutboxActiveState =
  (typeof PROJECT_EVENT_SOURCE_OUTBOX_ACTIVE_STATES)[number];
export type ProjectEventSourceOutboxTerminalState =
  (typeof PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_STATES)[number];
export type ProjectEventSourceOutboxState =
  | ProjectEventSourceOutboxActiveState
  | ProjectEventSourceOutboxTerminalState;

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

export interface ProjectEventSourceOutboxIntent {
  id: string;
  projectId: string;
  source: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  deliveryKey: string;
  payloadFingerprint: string;
  eventPayloadJson: string;
  state: ProjectEventSourceOutboxState;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: string;
  credentialLimitWindowType?: string | null;
  credentialLimitObservedAt?: number | null;
  claimToken: string | null;
  admittedEventId: string | null;
  admissionOutcome: ProjectEventAdmissionOutcome | null;
  lastError: string | null;
  terminalizedAt: string | null;
}

export interface ProjectEventSourceAdmissionResult {
  intentId: string;
  state: ProjectEventSourceOutboxState;
  admissionOutcome?: ProjectEventAdmissionOutcome;
  eventId?: string;
  attemptCount?: number;
  conflict?: {
    deliveryKey: string;
    existingFingerprint: string;
    incomingFingerprint: string;
    reason: string;
  };
}

export interface ProjectEventSourceOutboxStats {
  attempted: number;
  admitted: number;
  retryableFailed: number;
  permanentFailed: number;
  expired: number;
  skipped: number;
  terminalDeleted: number;
  timedOut: number;
  hasMore: boolean;
}

type TaskTerminalCaptureGuard = {
  kind: 'task_terminal_transition';
  projectId: string;
  taskId: string;
  terminalTransitionId: string;
};

type CredentialLimitWindowCaptureGuard = {
  kind: 'credential_limit_window_transition';
  projectId: string;
  credentialReference: string;
  windowType: string;
  observedAt: number;
  lastEventDeliveryKey: string;
};

export type ProjectEventSourceOutboxCaptureGuard =
  | TaskTerminalCaptureGuard
  | CredentialLimitWindowCaptureGuard;

export type ProjectEventSourceOutboxInsertOptions = {
  now?: Date;
  id?: string;
  capture?: ProjectEventSourceOutboxCaptureGuard;
};

export type ProjectEventSourceAdmissionTiming =
  | Date
  | {
      now?: Date;
      clock?: () => Date;
      admissionTimeoutMs?: number;
    };

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
