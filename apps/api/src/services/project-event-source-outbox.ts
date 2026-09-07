import type { AdmitProjectEventInput, ProjectEventJsonValue } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { canonicalJson } from '../lib/canonical-json';
import { createModuleLogger } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';
import {
  credentialLimitAdmissionGuard,
  credentialLimitIntentSuperseded,
  credentialLimitSupersededUpdate,
} from './project-event-source-outbox-credential';
import {
  PROJECT_EVENT_SOURCE_OUTBOX_ACTIVE_STATES,
  PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_STATES,
  type ProjectEventSourceAdmissionResult,
  ProjectEventSourceAdmissionTimeoutError,
  type ProjectEventSourceAdmissionTiming,
  type ProjectEventSourceOutboxActiveState,
  type ProjectEventSourceOutboxCaptureGuard,
  type ProjectEventSourceOutboxConfig,
  type ProjectEventSourceOutboxInsertOptions,
  type ProjectEventSourceOutboxIntent,
  type ProjectEventSourceOutboxState,
  type ProjectEventSourceOutboxStats,
  type ProjectEventSourceOutboxTerminalState,
  resolveProjectEventSourceOutboxConfig,
} from './project-event-source-outbox-contract';

export type {
  ProjectEventSourceAdmissionResult,
  ProjectEventSourceAdmissionTiming,
  ProjectEventSourceOutboxCaptureGuard,
  ProjectEventSourceOutboxConfig,
  ProjectEventSourceOutboxIntent,
  ProjectEventSourceOutboxState,
  ProjectEventSourceOutboxStats,
} from './project-event-source-outbox-contract';

const log = createModuleLogger('project_event_source_outbox');
const ACTIVE_STATES = PROJECT_EVENT_SOURCE_OUTBOX_ACTIVE_STATES;
const TERMINAL_STATES = PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_STATES;
const ACTIVE_STATE_SQL = "'pending', 'retryable_failed', 'processing'";

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

function insertValues(
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
    jsonPayload(input),
    config.maxAttempts,
    nowIso,
    expiresAt,
    options.capture?.kind === 'credential_limit_window_transition'
      ? options.capture.windowType
      : null,
    options.capture?.kind === 'credential_limit_window_transition'
      ? options.capture.observedAt
      : null,
    nowIso,
    nowIso,
  ] as const;
}

function assertCaptureMatchesInput(
  input: AdmitProjectEventInput,
  capture: ProjectEventSourceOutboxCaptureGuard
): void {
  if (capture.projectId !== input.projectId) {
    throw new Error('Project event source outbox capture project does not match intent project');
  }
  if (
    capture.kind === 'credential_limit_window_transition' &&
    capture.lastEventDeliveryKey !== input.deliveryKey
  ) {
    throw new Error('Credential limit capture delivery key does not match intent delivery key');
  }
}

export function projectEventSourceOutboxInsertStatement(
  env: Env,
  input: AdmitProjectEventInput,
  options: ProjectEventSourceOutboxInsertOptions = {}
): D1PreparedStatement {
  if (options.capture) assertCaptureMatchesInput(input, options.capture);
  const values = insertValues(env, input, options);
  const columns = `(id, project_id, source, event_type, subject_type, subject_id, delivery_key,
       payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
       next_attempt_at, expires_at, credential_limit_window_type, credential_limit_observed_at,
       created_at, updated_at)`;
  if (options.capture?.kind === 'task_terminal_transition') {
    const guard = options.capture;
    return env.DATABASE.prepare(
      `INSERT OR IGNORE INTO project_event_source_outbox ${columns}
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM tasks
           WHERE id = ? AND project_id = ? AND terminal_transition_id = ?
       )`
    ).bind(...values, guard.taskId, guard.projectId, guard.terminalTransitionId);
  }
  if (options.capture?.kind === 'credential_limit_window_transition') {
    const guard = options.capture;
    return env.DATABASE.prepare(
      `INSERT OR IGNORE INTO project_event_source_outbox ${columns}
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM credential_limit_windows
           WHERE project_id = ?
             AND credential_reference = ?
             AND window_type = ?
             AND observed_at = ?
             AND last_event_delivery_key = ?
        )`
    ).bind(
      ...values,
      guard.projectId,
      guard.credentialReference,
      guard.windowType,
      guard.observedAt,
      guard.lastEventDeliveryKey
    );
  }
  return env.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_event_source_outbox ${columns}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(...values);
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
            credential_limit_observed_at AS credentialLimitObservedAt,
            claim_token AS claimToken,
            admitted_event_id AS admittedEventId, admission_outcome AS admissionOutcome,
            last_error AS lastError,
            terminalized_at AS terminalizedAt
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
            credential_limit_observed_at AS credentialLimitObservedAt,
            claim_token AS claimToken,
            admitted_event_id AS admittedEventId, admission_outcome AS admissionOutcome,
            last_error AS lastError,
            terminalized_at AS terminalizedAt
       FROM project_event_source_outbox
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<ProjectEventSourceOutboxIntent>();
}

async function loadIntentByClaim(
  env: Env,
  id: string,
  claimToken: string
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `SELECT id, project_id AS projectId, source, event_type AS eventType,
            subject_type AS subjectType, subject_id AS subjectId,
            delivery_key AS deliveryKey, payload_fingerprint AS payloadFingerprint,
            event_payload_json AS eventPayloadJson, state,
            attempt_count AS attemptCount, max_attempts AS maxAttempts,
            expires_at AS expiresAt,
            credential_limit_window_type AS credentialLimitWindowType,
            credential_limit_observed_at AS credentialLimitObservedAt,
            claim_token AS claimToken,
            admitted_event_id AS admittedEventId, admission_outcome AS admissionOutcome,
            last_error AS lastError,
            terminalized_at AS terminalizedAt
       FROM project_event_source_outbox
      WHERE id = ? AND state = 'processing' AND claim_token = ?
      LIMIT 1`
  )
    .bind(id, claimToken)
    .first<ProjectEventSourceOutboxIntent>();
}

function replayConflict(intent: ProjectEventSourceOutboxIntent, input: AdmitProjectEventInput) {
  const incomingPayload = jsonPayload(input);
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

async function markLocalReplayConflict(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  input: AdmitProjectEventInput,
  reason: string,
  now = new Date()
): Promise<ProjectEventSourceAdmissionResult> {
  if (ACTIVE_STATES.includes(intent.state as ProjectEventSourceOutboxActiveState)) {
    await env.DATABASE.prepare(
      `UPDATE project_event_source_outbox
          SET state = 'permanent_failed', processing_lease_expires_at = NULL,
              claim_token = NULL, admission_outcome = 'conflict', terminalized_at = ?,
              last_error = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND state IN (${ACTIVE_STATE_SQL})`
    )
      .bind(
        now.toISOString(),
        `Conflicting replay: ${reason}`,
        now.toISOString(),
        intent.id,
        input.projectId
      )
      .run();
  }
  return {
    intentId: intent.id,
    state: 'permanent_failed',
    admissionOutcome: 'conflict',
    eventId: intent.admittedEventId ?? undefined,
    conflict: {
      deliveryKey: intent.deliveryKey,
      existingFingerprint: intent.payloadFingerprint,
      incomingFingerprint: input.payloadFingerprint,
      reason,
    },
  };
}

export async function enqueueProjectEventSourceIntent(
  env: Env,
  input: AdmitProjectEventInput,
  options: ProjectEventSourceOutboxInsertOptions = {}
): Promise<ProjectEventSourceOutboxIntent> {
  await projectEventSourceOutboxInsertStatement(env, input, options).run();
  const intentById = options.id ? await loadIntentById(env, options.id) : null;
  const intent =
    intentById && replayConflict(intentById, input) === null
      ? intentById
      : await loadIntentByDelivery(env, input);
  if (!intent) throw new Error('Project event source outbox intent was not persisted');
  const conflict = replayConflict(intent, input);
  if (conflict) {
    await markLocalReplayConflict(env, intent, input, conflict, options.now ?? new Date());
    throw new Error(`Project event source outbox delivery replay conflict: ${conflict}`);
  }
  return intent;
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

function clockFrom(input: ProjectEventSourceAdmissionTiming | undefined): () => Date {
  if (input instanceof Date) return () => new Date(input.getTime());
  if (input?.clock) return input.clock;
  if (input?.now) return () => new Date(input.now?.getTime() ?? Date.now());
  return () => new Date();
}

function resultFromIntent(
  intent: ProjectEventSourceOutboxIntent
): ProjectEventSourceAdmissionResult {
  return {
    intentId: intent.id,
    state: intent.state,
    admissionOutcome: intent.admissionOutcome ?? undefined,
    eventId: intent.admittedEventId ?? undefined,
    attemptCount: intent.attemptCount,
  };
}

async function terminalizeIneligibleClaim(env: Env, id: string, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'expired', processing_lease_expires_at = NULL, claim_token = NULL,
            terminalized_at = ?, last_error = COALESCE(last_error, 'Intent expired'), updated_at = ?
      WHERE id = ? AND state IN (${ACTIVE_STATE_SQL}) AND expires_at <= ?`
  )
    .bind(nowIso, nowIso, id, nowIso)
    .run();
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed', processing_lease_expires_at = NULL, claim_token = NULL,
            terminalized_at = ?, last_error = COALESCE(last_error, 'Max attempts exhausted'), updated_at = ?
      WHERE id = ? AND (
        (state IN ('pending', 'retryable_failed') AND (attempt_count >= max_attempts) = 1)
        OR (
          state = 'processing'
          AND processing_lease_expires_at IS NOT NULL
          AND processing_lease_expires_at <= ?
          AND (attempt_count >= max_attempts) = 1
        )
      )`
  )
    .bind(nowIso, nowIso, id, nowIso)
    .run();
}

async function claimIntent(
  env: Env,
  id: string,
  now: Date
): Promise<ProjectEventSourceOutboxIntent | null> {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const claimToken = ulid();
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + config.processingLeaseMs).toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'processing', attempt_count = attempt_count + 1,
            claim_token = ?, claimed_at = ?, processing_lease_expires_at = ?,
            last_error = NULL, updated_at = ?
      WHERE id = ? AND expires_at > ? AND attempt_count < max_attempts
        AND (
          (state IN ('pending', 'retryable_failed') AND next_attempt_at <= ?)
          OR (state = 'processing' AND processing_lease_expires_at IS NOT NULL
              AND processing_lease_expires_at <= ?)
        )`
  )
    .bind(claimToken, nowIso, leaseExpiresAt, nowIso, id, nowIso, nowIso, nowIso)
    .run();
  if (Number(result.meta.changes ?? 0) === 0) {
    await terminalizeIneligibleClaim(env, id, now);
    return null;
  }
  return loadIntentByClaim(env, id, claimToken);
}

async function beginCredentialClaimedIntentAdmission(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  payload: Omit<AdmitProjectEventInput, 'projectId'>,
  now: Date
): Promise<
  | { outcome: 'ready'; intent: ProjectEventSourceOutboxIntent }
  | { outcome: 'terminal'; result: ProjectEventSourceAdmissionResult }
> {
  const guard = credentialLimitAdmissionGuard(intent, payload);
  if (!guard) return { outcome: 'ready', intent };
  const nowIso = now.toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET updated_at = ?
      WHERE id = ? AND state = 'processing' AND claim_token = ?
        ${guard.sql}`
  )
    .bind(nowIso, intent.id, intent.claimToken, ...guard.values)
    .run();
  if (Number(result.meta.changes ?? 0) === 1) {
    return { outcome: 'ready', intent };
  }

  const current = await loadIntentById(env, intent.id);
  if (!current) {
    return { outcome: 'terminal', result: { intentId: intent.id, state: 'permanent_failed' } };
  }
  if (
    current.state === 'processing' &&
    current.claimToken === intent.claimToken &&
    (await credentialLimitIntentSuperseded(env, current, payload))
  ) {
    const superseded = credentialLimitSupersededUpdate(now);
    return {
      outcome: 'terminal',
      result: await updateClaimedIntent(env, current, superseded.sqlSet, superseded.values),
    };
  }
  return { outcome: 'terminal', result: resultFromIntent(current) };
}

async function updateClaimedIntent(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  sqlSet: string,
  values: readonly unknown[]
): Promise<ProjectEventSourceAdmissionResult> {
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox ${sqlSet}
      WHERE id = ? AND state = 'processing' AND claim_token = ?`
  )
    .bind(...values, intent.id, intent.claimToken)
    .run();
  const current = await loadIntentById(env, intent.id);
  if (Number(result.meta.changes ?? 0) === 0 && current) return resultFromIntent(current);
  return current ? resultFromIntent(current) : { intentId: intent.id, state: 'permanent_failed' };
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
  return updateClaimedIntent(
    env,
    intent,
    `SET state = ?, next_attempt_at = ?, processing_lease_expires_at = NULL,
         claim_token = NULL, terminalized_at = CASE WHEN ? = 'retryable_failed' THEN NULL ELSE ? END,
         last_error = ?, updated_at = ?`,
    [state, nextAttemptAt.toISOString(), state, nowIso, errorText(error), nowIso]
  );
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

function withAdmissionTimeout<T>(createPromise: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new ProjectEventSourceAdmissionTimeoutError(timeoutMs));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new ProjectEventSourceAdmissionTimeoutError(timeoutMs)),
      timeoutMs
    );
    createPromise()
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}

async function admitClaimedIntent(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  clock: () => Date,
  admissionTimeoutMs?: number
): Promise<ProjectEventSourceAdmissionResult> {
  let payload: Omit<AdmitProjectEventInput, 'projectId'>;
  try {
    payload = parseEventPayload(intent);
  } catch (error) {
    return updateClaimedIntent(
      env,
      intent,
      `SET state = 'permanent_failed', processing_lease_expires_at = NULL,
           claim_token = NULL, terminalized_at = ?, last_error = ?, updated_at = ?`,
      [clock().toISOString(), errorText(error), clock().toISOString()]
    );
  }

  try {
    const now = clock();
    if (await credentialLimitIntentSuperseded(env, intent, payload)) {
      const superseded = credentialLimitSupersededUpdate(now);
      return await updateClaimedIntent(env, intent, superseded.sqlSet, superseded.values);
    }
    const config = resolveProjectEventSourceOutboxConfig(env);
    const timeoutMs = Math.min(
      config.admissionTimeoutMs,
      Math.max(0, Math.floor(admissionTimeoutMs ?? config.admissionTimeoutMs))
    );
    const currentClaim = await loadIntentByClaim(env, intent.id, intent.claimToken ?? '');
    if (!currentClaim) {
      const current = await loadIntentById(env, intent.id);
      return current ? resultFromIntent(current) : resultFromIntent(intent);
    }
    const admissionFence = await beginCredentialClaimedIntentAdmission(
      env,
      currentClaim,
      payload,
      now
    );
    if (admissionFence.outcome === 'terminal') return admissionFence.result;
    const result = await withAdmissionTimeout(
      () => projectDataService.admitProjectEvent(env, intent.projectId, payload),
      timeoutMs
    );
    const state: ProjectEventSourceOutboxState =
      result.outcome === 'conflict' ? 'permanent_failed' : 'admitted';
    const nowIso = clock().toISOString();
    return await updateClaimedIntent(
      env,
      admissionFence.intent,
      `SET state = ?, processing_lease_expires_at = NULL, claim_token = NULL,
           admitted_event_id = ?, admission_outcome = ?, terminalized_at = ?,
           last_error = ?, updated_at = ?`,
      [
        state,
        result.event.id,
        result.outcome,
        nowIso,
        result.outcome === 'conflict' ? 'ProjectData admission conflict' : null,
        nowIso,
      ]
    );
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
    return markIntentFailed(env, intent, error, clock());
  }
}

export async function admitProjectEventSourceIntentById(
  env: Env,
  id: string,
  timing?: ProjectEventSourceAdmissionTiming
): Promise<ProjectEventSourceAdmissionResult | null> {
  const clock = clockFrom(timing);
  const intent = await claimIntent(env, id, clock());
  if (!intent) {
    const existing = await loadIntentById(env, id);
    return existing ? resultFromIntent(existing) : null;
  }
  const admissionTimeoutMs = timing instanceof Date ? undefined : timing?.admissionTimeoutMs;
  return admitClaimedIntent(env, intent, clock, admissionTimeoutMs);
}

export async function enqueueAndAdmitProjectEventSourceIntent(
  env: Env,
  input: AdmitProjectEventInput
): Promise<ProjectEventSourceAdmissionResult> {
  let intent: ProjectEventSourceOutboxIntent;
  try {
    intent = await enqueueProjectEventSourceIntent(env, input);
  } catch (error) {
    const existing = await loadIntentByDelivery(env, input);
    if (!existing) throw error;
    const reason = replayConflict(existing, input);
    if (!reason) throw error;
    return markLocalReplayConflict(env, existing, input, reason);
  }
  return (await admitProjectEventSourceIntentById(env, intent.id)) ?? resultFromIntent(intent);
}

async function updateOpenRows(
  env: Env,
  state: ProjectEventSourceOutboxActiveState,
  predicate: string,
  orderBy: string,
  values: readonly unknown[],
  terminalState: 'expired' | 'permanent_failed',
  terminalReason: string,
  now: Date,
  limit: number
): Promise<number> {
  if (limit <= 0) return 0;
  const nowIso = now.toISOString();
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = ?, processing_lease_expires_at = NULL, claim_token = NULL,
            terminalized_at = ?, last_error = COALESCE(last_error, ?), updated_at = ?
      WHERE id IN (
        SELECT id FROM project_event_source_outbox
         WHERE state = ? AND ${predicate}
         ORDER BY ${orderBy}
         LIMIT ?
      )`
  )
    .bind(terminalState, nowIso, terminalReason, nowIso, state, ...values, limit)
    .run();
  return Number(result.meta.changes ?? 0);
}

async function deleteTerminalRows(
  env: Env,
  state: ProjectEventSourceOutboxTerminalState,
  beforeIso: string,
  limit: number
): Promise<number> {
  if (limit <= 0) return 0;
  const result = await env.DATABASE.prepare(
    `DELETE FROM project_event_source_outbox
      WHERE id IN (
        SELECT id FROM project_event_source_outbox
         WHERE state = ? AND terminalized_at IS NOT NULL AND terminalized_at <= ?
         ORDER BY terminalized_at, id
         LIMIT ?
      )`
  )
    .bind(state, beforeIso, limit)
    .run();
  return Number(result.meta.changes ?? 0);
}

async function backfillLegacyTerminalizedRows(
  env: Env,
  state: ProjectEventSourceOutboxTerminalState,
  fallbackIso: string,
  limit: number
): Promise<number> {
  if (limit <= 0) return 0;
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET terminalized_at = COALESCE(updated_at, created_at, ?), updated_at = ?
      WHERE id IN (
        SELECT id FROM project_event_source_outbox
         WHERE state = ? AND terminalized_at IS NULL
         ORDER BY terminalized_at, id
         LIMIT ?
      )`
  )
    .bind(fallbackIso, fallbackIso, state, limit)
    .run();
  return Number(result.meta.changes ?? 0);
}

async function terminalizeExhaustedRows(
  env: Env,
  state: ProjectEventSourceOutboxActiveState,
  now: Date,
  limit: number
): Promise<number> {
  if (limit <= 0) return 0;
  const nowIso = now.toISOString();
  const processingPredicate =
    state === 'processing'
      ? `AND processing_lease_expires_at IS NOT NULL AND processing_lease_expires_at <= ?`
      : '';
  const bindValues = state === 'processing' ? [state, nowIso, limit] : [state, limit];
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed', processing_lease_expires_at = NULL,
            claim_token = NULL, terminalized_at = ?,
            last_error = COALESCE(last_error, 'Max attempts exhausted'), updated_at = ?
      WHERE id IN (
        SELECT id FROM project_event_source_outbox
         WHERE state = ? AND (attempt_count >= max_attempts) = 1
         ${processingPredicate}
         ORDER BY processing_lease_expires_at, id
         LIMIT ?
      )`
  )
    .bind(nowIso, nowIso, ...bindValues)
    .run();
  return Number(result.meta.changes ?? 0);
}

async function selectCandidateIds(env: Env, nowIso: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  for (const state of ['pending', 'retryable_failed'] as const) {
    if (ids.length >= limit) break;
    const rows = await env.DATABASE.prepare(
      `SELECT id FROM (
         SELECT id, expires_at, attempt_count, max_attempts
           FROM project_event_source_outbox
          WHERE state = ? AND next_attempt_at <= ?
          ORDER BY next_attempt_at, id
          LIMIT ?
       )
       WHERE expires_at > ? AND attempt_count < max_attempts`
    )
      .bind(state, nowIso, limit - ids.length, nowIso)
      .all<{ id: string }>();
    ids.push(...(rows.results ?? []).map((row) => row.id));
  }
  if (ids.length < limit) {
    const rows = await env.DATABASE.prepare(
      `SELECT id FROM (
         SELECT id, expires_at, attempt_count, max_attempts
           FROM project_event_source_outbox
          WHERE state = 'processing' AND processing_lease_expires_at IS NOT NULL
            AND processing_lease_expires_at <= ?
          ORDER BY processing_lease_expires_at, id
          LIMIT ?
       )
       WHERE expires_at > ? AND attempt_count < max_attempts`
    )
      .bind(nowIso, limit - ids.length, nowIso)
      .all<{ id: string }>();
    ids.push(...(rows.results ?? []).map((row) => row.id));
  }
  return ids;
}

function countResult(
  stats: ProjectEventSourceOutboxStats,
  result: ProjectEventSourceAdmissionResult | null
): void {
  if (!result) {
    stats.skipped += 1;
    return;
  }
  if (result.state === 'admitted') stats.admitted += 1;
  else if (result.state === 'retryable_failed') stats.retryableFailed += 1;
  else if (result.state === 'permanent_failed') stats.permanentFailed += 1;
  else if (result.state === 'expired') stats.expired += 1;
  else stats.skipped += 1;
  if (result.state !== 'pending' && result.state !== 'processing') {
    stats.attempted += 1;
  }
}

export async function reconcileProjectEventSourceOutbox(
  env: Env,
  options: { limit?: number; now?: Date; clock?: () => Date } = {}
): Promise<ProjectEventSourceOutboxStats> {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const limit = Math.max(1, Math.min(options.limit ?? config.batchRows, config.batchRows));
  const clock = clockFrom(options.clock ? { clock: options.clock } : options.now);
  const deadline = Date.now() + config.sweepWallMs;
  const stats: ProjectEventSourceOutboxStats = {
    attempted: 0,
    admitted: 0,
    retryableFailed: 0,
    permanentFailed: 0,
    expired: 0,
    skipped: 0,
    terminalDeleted: 0,
    timedOut: 0,
    hasMore: false,
  };
  let remaining = limit;
  const spend = (changedRows: number) => {
    const before = remaining;
    remaining = Math.max(0, remaining - changedRows);
    if (changedRows >= before) stats.hasMore = true;
  };

  for (const state of ACTIVE_STATES) {
    const changed = await updateOpenRows(
      env,
      state,
      'expires_at <= ?',
      'expires_at, id',
      [clock().toISOString()],
      'expired',
      'Intent expired',
      clock(),
      remaining
    );
    stats.expired += changed;
    spend(changed);
    if (remaining <= 0 || Date.now() >= deadline) return stats;
  }
  for (const state of ACTIVE_STATES) {
    const changed = await terminalizeExhaustedRows(env, state, clock(), remaining);
    stats.permanentFailed += changed;
    spend(changed);
    if (remaining <= 0 || Date.now() >= deadline) return stats;
  }
  if (config.terminalRetentionMs >= 0) {
    const cutoff = new Date(clock().getTime() - config.terminalRetentionMs).toISOString();
    for (const state of TERMINAL_STATES) {
      const backfilled = await backfillLegacyTerminalizedRows(
        env,
        state,
        clock().toISOString(),
        remaining
      );
      spend(backfilled);
      if (remaining <= 0 || Date.now() >= deadline) return stats;
      const deleted = await deleteTerminalRows(env, state, cutoff, remaining);
      stats.terminalDeleted += deleted;
      spend(deleted);
      if (remaining <= 0 || Date.now() >= deadline) return stats;
    }
  }

  const ids = await selectCandidateIds(env, clock().toISOString(), remaining);
  stats.hasMore = stats.hasMore || ids.length >= remaining;
  for (const id of ids) {
    if (Date.now() >= deadline) {
      stats.hasMore = true;
      break;
    }
    const remainingWallMs = Math.max(0, deadline - Date.now());
    const result = await admitProjectEventSourceIntentById(env, id, {
      clock,
      admissionTimeoutMs: remainingWallMs,
    });
    spend(1);
    if (result?.state === 'retryable_failed') {
      const current = await loadIntentById(env, id);
      if (current?.claimToken === null && current.lastError?.includes('timed out'))
        stats.timedOut += 1;
    }
    countResult(stats, result);
  }
  return stats;
}
