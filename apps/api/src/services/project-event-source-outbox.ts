import type {
  AdmitProjectEventInput,
  ProjectEventAdmissionOutcome,
  ProjectEventJsonValue,
} from '@simple-agent-manager/shared';
import {
  CREDENTIAL_LIMIT_EVENT_SOURCE,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_BATCH_ROWS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_MAX_ATTEMPTS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_PROCESSING_LEASE_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_BASE_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_RETRY_MAX_MS,
  DEFAULT_PROJECT_EVENT_SOURCE_OUTBOX_TTL_MS,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { createModuleLogger } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';

const log = createModuleLogger('project_event_source_outbox');

export type ProjectEventSourceOutboxState =
  | 'pending'
  | 'processing'
  | 'retryable_failed'
  | 'admitted'
  | 'expired'
  | 'permanent_failed';

export interface ProjectEventSourceOutboxConfig {
  batchRows: number;
  maxAttempts: number;
  ttlMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  processingLeaseMs: number;
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
}

export interface ProjectEventSourceAdmissionResult {
  intentId: string;
  state: ProjectEventSourceOutboxState;
  admissionOutcome?: ProjectEventAdmissionOutcome;
  eventId?: string;
}

export interface ProjectEventSourceOutboxStats {
  attempted: number;
  admitted: number;
  retryableFailed: number;
  permanentFailed: number;
  expired: number;
  skipped: number;
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
  };
}

function withoutProjectId(
  input: AdmitProjectEventInput
): Omit<AdmitProjectEventInput, 'projectId'> {
  const { projectId, ...event } = input;
  void projectId;
  return event;
}

function jsonPayload(input: AdmitProjectEventInput): string {
  return canonicalJson(withoutProjectId(input) as unknown as ProjectEventJsonValue);
}

export function projectEventSourceOutboxInsertStatement(
  env: Env,
  input: AdmitProjectEventInput,
  options: { now?: Date; id?: string } = {}
): D1PreparedStatement {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.ttlMs).toISOString();
  return env.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_event_source_outbox
      (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
       payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
       next_attempt_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
  ).bind(
    options.id ?? ulid(),
    input.projectId,
    input.source,
    input.eventType,
    input.subject.type,
    input.subject.id,
    input.deliveryKey,
    input.payloadFingerprint,
    jsonPayload(input),
    config.maxAttempts,
    nowIso,
    expiresAt,
    nowIso,
    nowIso
  );
}

async function loadIntentByDelivery(
  env: Env,
  input: Pick<AdmitProjectEventInput, 'projectId' | 'source' | 'deliveryKey'>
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `SELECT id, project_id AS projectId, source, event_type AS eventType,
            subject_type AS subjectType, subject_id AS subjectId,
            delivery_key AS deliveryKey, payload_fingerprint AS payloadFingerprint,
            event_payload_json AS eventPayloadJson, state,
            attempt_count AS attemptCount, max_attempts AS maxAttempts,
            expires_at AS expiresAt,
            credential_limit_window_type AS credentialLimitWindowType,
            credential_limit_observed_at AS credentialLimitObservedAt
       FROM project_event_source_outbox
      WHERE project_id = ? AND source = ? AND delivery_key = ?
      LIMIT 1`
  )
    .bind(input.projectId, input.source, input.deliveryKey)
    .first<ProjectEventSourceOutboxIntent>();
}

async function loadIntentById(
  env: Env,
  id: string
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `SELECT id, project_id AS projectId, source, event_type AS eventType,
            subject_type AS subjectType, subject_id AS subjectId,
            delivery_key AS deliveryKey, payload_fingerprint AS payloadFingerprint,
            event_payload_json AS eventPayloadJson, state,
            attempt_count AS attemptCount, max_attempts AS maxAttempts,
            expires_at AS expiresAt,
            credential_limit_window_type AS credentialLimitWindowType,
            credential_limit_observed_at AS credentialLimitObservedAt
       FROM project_event_source_outbox
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<ProjectEventSourceOutboxIntent>();
}

export async function enqueueProjectEventSourceIntent(
  env: Env,
  input: AdmitProjectEventInput
): Promise<ProjectEventSourceOutboxIntent> {
  await projectEventSourceOutboxInsertStatement(env, input).run();
  const intent = await loadIntentByDelivery(env, input);
  if (!intent) throw new Error('Project event source outbox intent was not persisted');
  return intent;
}

function claimPredicate(): string {
  return `(
    (state IN ('pending', 'retryable_failed') AND next_attempt_at <= ?)
    OR (state = 'processing' AND processing_lease_expires_at IS NOT NULL AND processing_lease_expires_at <= ?)
  )`;
}

async function claimIntent(env: Env, id: string, now: Date): Promise<boolean> {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + config.processingLeaseMs).toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'processing',
            attempt_count = attempt_count + 1,
            processing_lease_expires_at = ?,
            last_error = NULL,
            updated_at = ?
      WHERE id = ?
        AND expires_at > ?
        AND ${claimPredicate()}`
  )
    .bind(leaseExpiresAt, nowIso, id, nowIso, nowIso, nowIso)
    .run();
  return Number(result.meta.changes ?? 0) > 0;
}

function nextRetryAt(
  now: Date,
  attemptCount: number,
  config: ProjectEventSourceOutboxConfig
): Date {
  const exponent = Math.min(Math.max(0, attemptCount - 1), 16);
  const delay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** exponent);
  return new Date(now.getTime() + delay);
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.slice(0, 1024);
}

async function markIntentFailed(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  error: unknown,
  now: Date
): Promise<ProjectEventSourceAdmissionResult> {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const nowIso = now.toISOString();
  const expiresAtMs = Date.parse(intent.expiresAt);
  const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= now.getTime();
  const final = expired || intent.attemptCount >= intent.maxAttempts;
  const state: ProjectEventSourceOutboxState = expired
    ? 'expired'
    : final
      ? 'permanent_failed'
      : 'retryable_failed';
  const nextAttemptAt =
    state === 'retryable_failed' ? nextRetryAt(now, intent.attemptCount, config) : now;
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = ?, next_attempt_at = ?, processing_lease_expires_at = NULL,
            last_error = ?, updated_at = ?
      WHERE id = ? AND state = 'processing'`
  )
    .bind(state, nextAttemptAt.toISOString(), errorText(error), nowIso, intent.id)
    .run();
  return { intentId: intent.id, state };
}

function credentialLimitWindowFromIntent(
  intent: ProjectEventSourceOutboxIntent,
  payload: Omit<AdmitProjectEventInput, 'projectId'>
): { windowType: string; observedAt: number } | null {
  if (intent.source !== CREDENTIAL_LIMIT_EVENT_SOURCE) return null;
  if (intent.credentialLimitWindowType && typeof intent.credentialLimitObservedAt === 'number') {
    return {
      windowType: intent.credentialLimitWindowType,
      observedAt: intent.credentialLimitObservedAt,
    };
  }
  const metadata = payload.metadata;
  const windowType =
    metadata && typeof metadata.windowType === 'string' ? metadata.windowType : null;
  const observedAt =
    metadata && typeof metadata.observedAt === 'number' ? metadata.observedAt : null;
  if (!windowType || observedAt === null) return null;
  return { windowType, observedAt };
}

async function credentialLimitIntentSuperseded(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  payload: Omit<AdmitProjectEventInput, 'projectId'>
): Promise<boolean> {
  const window = credentialLimitWindowFromIntent(intent, payload);
  if (!window) return false;
  const newer = await env.DATABASE.prepare(
    `SELECT 1
       FROM credential_limit_windows
      WHERE project_id = ?
        AND credential_reference = ?
        AND window_type = ?
        AND observed_at > ?
        AND (last_event_delivery_key IS NULL OR last_event_delivery_key != ?)
      LIMIT 1`
  )
    .bind(
      intent.projectId,
      intent.subjectId,
      window.windowType,
      window.observedAt,
      intent.deliveryKey
    )
    .first<{ '1': number }>();
  return Boolean(newer);
}

async function markCredentialLimitIntentSuperseded(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  now: Date
): Promise<ProjectEventSourceAdmissionResult> {
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed', processing_lease_expires_at = NULL,
            last_error = 'Superseded by newer credential limit window before admission',
            updated_at = ?
      WHERE id = ? AND state = 'processing'`
  )
    .bind(now.toISOString(), intent.id)
    .run();
  return { intentId: intent.id, state: 'permanent_failed' };
}

function parseEventPayload(
  intent: ProjectEventSourceOutboxIntent
): Omit<AdmitProjectEventInput, 'projectId'> {
  const parsed = JSON.parse(intent.eventPayloadJson) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Project event source outbox payload is not an object');
  }
  const eventPayload = parsed as Omit<AdmitProjectEventInput, 'projectId'>;
  if (
    eventPayload.source !== intent.source ||
    eventPayload.eventType !== intent.eventType ||
    eventPayload.deliveryKey !== intent.deliveryKey ||
    eventPayload.payloadFingerprint !== intent.payloadFingerprint ||
    eventPayload.subject?.type !== intent.subjectType ||
    eventPayload.subject?.id !== intent.subjectId
  ) {
    throw new Error('Project event source outbox payload does not match indexed columns');
  }
  return eventPayload;
}

async function admitClaimedIntent(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  now: Date
): Promise<ProjectEventSourceAdmissionResult> {
  let payload: Omit<AdmitProjectEventInput, 'projectId'>;
  try {
    payload = parseEventPayload(intent);
  } catch (error) {
    await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'permanent_failed', processing_lease_expires_at = NULL,
              last_error = ?, updated_at = ?
        WHERE id = ? AND state = 'processing'`
    )
      .bind(errorText(error), now.toISOString(), intent.id)
      .run();
    return { intentId: intent.id, state: 'permanent_failed' };
  }

  try {
    if (await credentialLimitIntentSuperseded(env, intent, payload)) {
      return markCredentialLimitIntentSuperseded(env, intent, now);
    }
    const result = await projectDataService.admitProjectEvent(env, intent.projectId, payload);
    const stored = await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'admitted',
              processing_lease_expires_at = NULL,
              admitted_event_id = ?,
              admission_outcome = ?,
              last_error = NULL,
              updated_at = ?
        WHERE id = ? AND state = 'processing'`
    )
      .bind(result.event.id, result.outcome, now.toISOString(), intent.id)
      .run();
    if ((stored.meta.changes ?? 0) !== 1) {
      throw new Error('Project event source outbox admission result was not persisted');
    }
    return {
      intentId: intent.id,
      state: 'admitted',
      admissionOutcome: result.outcome,
      eventId: result.event.id,
    };
  } catch (error) {
    log.warn('project_event_source_outbox.admission_failed', {
      intentId: intent.id,
      projectId: intent.projectId,
      source: intent.source,
      eventType: intent.eventType,
      subjectType: intent.subjectType,
      subjectId: intent.subjectId,
      attemptCount: intent.attemptCount,
      error: errorText(error),
    });
    return markIntentFailed(env, intent, error, now);
  }
}

export async function admitProjectEventSourceIntentById(
  env: Env,
  id: string,
  now = new Date()
): Promise<ProjectEventSourceAdmissionResult | null> {
  if (!(await claimIntent(env, id, now))) {
    const existing = await loadIntentById(env, id);
    return existing ? { intentId: existing.id, state: existing.state } : null;
  }
  const intent = await loadIntentById(env, id);
  if (!intent) return null;
  return admitClaimedIntent(env, intent, now);
}

export async function enqueueAndAdmitProjectEventSourceIntent(
  env: Env,
  input: AdmitProjectEventInput
): Promise<ProjectEventSourceAdmissionResult> {
  const intent = await enqueueProjectEventSourceIntent(env, input);
  return (
    (await admitProjectEventSourceIntentById(env, intent.id)) ?? {
      intentId: intent.id,
      state: intent.state,
    }
  );
}

export async function reconcileProjectEventSourceOutbox(
  env: Env,
  options: { limit?: number; now?: Date } = {}
): Promise<ProjectEventSourceOutboxStats> {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const limit = Math.max(1, Math.min(options.limit ?? config.batchRows, config.batchRows));
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = await env.DATABASE.prepare(
    `SELECT id
       FROM project_event_source_outbox
      WHERE expires_at > ?
        AND ${claimPredicate()}
      ORDER BY next_attempt_at, id
      LIMIT ?`
  )
    .bind(nowIso, nowIso, nowIso, limit)
    .all<{ id: string }>();

  const stats: ProjectEventSourceOutboxStats = {
    attempted: 0,
    admitted: 0,
    retryableFailed: 0,
    permanentFailed: 0,
    expired: 0,
    skipped: 0,
  };
  for (const row of rows.results ?? []) {
    const result = await admitProjectEventSourceIntentById(env, row.id, now);
    if (!result) {
      stats.skipped += 1;
      continue;
    }
    if (['admitted', 'retryable_failed', 'permanent_failed', 'expired'].includes(result.state)) {
      stats.attempted += 1;
    }
    if (result.state === 'admitted') stats.admitted += 1;
    else if (result.state === 'retryable_failed') stats.retryableFailed += 1;
    else if (result.state === 'permanent_failed') stats.permanentFailed += 1;
    else if (result.state === 'expired') stats.expired += 1;
    else stats.skipped += 1;
  }
  return stats;
}
