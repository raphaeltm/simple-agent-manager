import {
  type AdmitProjectEventInput,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_ADMISSION_TIMEOUT_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_PROCESSING_LEASE_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_SWEEP_WALL_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_RETENTION_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TTL_MS,
  type ProjectEventAdmissionOutcome,
  type ProjectEventJsonValue,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { ulid } from '../lib/ulid';

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
  claimToken: string | null;
  admittedEventId: string | null;
  admissionOutcome: ProjectEventAdmissionOutcome | null;
  lastError: string | null;
  terminalizedAt: string | null;
  credentialLimitWindowType?: string | null;
  credentialLimitObservedAt?: number | null;
}

export interface ProjectEventSourceAdmissionResult {
  intentId: string;
  state: ProjectEventSourceOutboxState;
  admissionOutcome?: ProjectEventAdmissionOutcome;
  eventId?: string;
  attemptCount?: number;
  outboxMutations?: number;
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
  outboxMutations: number;
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
  maxActiveIntentsPerProject: number;
};

export type ProjectEventSourceOutboxCaptureGuard =
  | TaskTerminalCaptureGuard
  | CredentialLimitWindowCaptureGuard;

export type ProjectEventSourceOutboxInsertOptions = {
  now?: Date;
  id?: string;
  capture?: ProjectEventSourceOutboxCaptureGuard;
};

export type ProjectEventSourceOutboxReadByIdInput = {
  id: string;
  projectId: string;
  source: string;
  deliveryKey: string;
};

export type ProjectEventSourceOutboxSupersedeInput = ProjectEventSourceOutboxReadByIdInput & {
  now?: Date;
  reason?: string;
};

export type ProjectEventSourceAdmissionTiming =
  | Date
  | {
      now?: Date;
      clock?: () => Date;
      admissionTimeoutMs?: number;
      deadlineMs?: number;
    };

export function projectEventSourceOutboxPayload(input: AdmitProjectEventInput): string {
  const { projectId, ...event } = input;
  void projectId;
  return canonicalJson(event as unknown as ProjectEventJsonValue);
}

export function projectEventSourceOutboxReplayConflict(
  intent: ProjectEventSourceOutboxIntent,
  input: AdmitProjectEventInput
): string | null {
  const incomingPayload = projectEventSourceOutboxPayload(input);
  if (intent.projectId !== input.projectId) return 'project_mismatch';
  if (intent.source !== input.source) return 'source_mismatch';
  if (intent.eventType !== input.eventType) return 'event_type_mismatch';
  if (intent.deliveryKey !== input.deliveryKey) return 'delivery_key_mismatch';
  if (intent.subjectType !== input.subject.type || intent.subjectId !== input.subject.id) {
    return 'subject_mismatch';
  }
  if (intent.payloadFingerprint !== input.payloadFingerprint) return 'payload_fingerprint_mismatch';
  if (intent.eventPayloadJson !== incomingPayload) return 'event_payload_mismatch';
  return null;
}

export function assertProjectEventSourceOutboxCaptureMatchesInput(
  input: AdmitProjectEventInput,
  capture: ProjectEventSourceOutboxCaptureGuard
): void {
  if (capture.projectId !== input.projectId) {
    throw new Error('Project event source outbox capture project does not match intent project');
  }
  if (capture.kind !== 'credential_limit_window_transition') return;
  if (capture.credentialReference !== input.subject.id) {
    throw new Error('Credential limit capture credential does not match intent subject');
  }
  if (!Number.isInteger(capture.observedAt) || capture.observedAt < 0) {
    throw new Error('Credential limit capture observedAt must be a non-negative integer');
  }
  if (
    !Number.isInteger(capture.maxActiveIntentsPerProject) ||
    capture.maxActiveIntentsPerProject < 1
  ) {
    throw new Error('Credential limit capture capacity must be a positive integer');
  }
}

export function projectEventSourceOutboxInsertValues(
  env: Env,
  input: AdmitProjectEventInput,
  options: ProjectEventSourceOutboxInsertOptions
) {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.ttlMs).toISOString();
  return [
    options.id ?? ulid(),
    input.projectId,
    input.source,
    input.eventType,
    input.subject.type,
    input.subject.id,
    input.deliveryKey,
    input.payloadFingerprint,
    projectEventSourceOutboxPayload(input),
    config.maxAttempts,
    nowIso,
    expiresAt,
    nowIso,
    nowIso,
  ] as const;
}

export function projectEventSourceOutboxNextRetryAt(
  now: Date,
  attemptCount: number,
  config: ProjectEventSourceOutboxConfig
): Date {
  const exponent = Math.min(Math.max(0, attemptCount - 1), 16);
  const delay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** exponent);
  return new Date(now.getTime() + delay);
}

export function projectEventSourceOutboxErrorText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.slice(0, 1024);
}

export function projectEventSourceOutboxClockFrom(
  input: ProjectEventSourceAdmissionTiming | undefined
): () => Date {
  if (input instanceof Date) return () => new Date(input.getTime());
  if (input?.clock) return input.clock;
  if (input?.now) return () => new Date(input.now?.getTime() ?? Date.now());
  return () => new Date();
}

export function projectEventSourceAdmissionTimeoutMs(
  config: ProjectEventSourceOutboxConfig,
  admissionTimeoutMs?: number,
  deadlineMs?: number
): number {
  const configured = Math.min(
    config.admissionTimeoutMs,
    Math.max(0, Math.floor(admissionTimeoutMs ?? config.admissionTimeoutMs))
  );
  return deadlineMs === undefined
    ? configured
    : Math.min(configured, Math.max(0, Math.floor(deadlineMs - Date.now())));
}

export function withProjectEventSourceAdmissionTimeout<T>(
  createPromise: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new ProjectEventSourceAdmissionTimeoutError(timeoutMs));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new ProjectEventSourceAdmissionTimeoutError(timeoutMs)),
      timeoutMs
    );
    createPromise().then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number, min = 1): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function resolveProjectEventSourceOutboxConfig(
  env: Env
): ProjectEventSourceOutboxConfig {
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
