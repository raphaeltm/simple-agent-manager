import type { AdmitProjectEventInput, ProjectEventJsonValue } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { canonicalJson } from '../../lib/canonical-json';
import { ulid } from '../../lib/ulid';
import {
  admitProjectEventSourceIntentById,
  type ProjectEventSourceAdmissionResult,
  type ProjectEventSourceOutboxState,
} from '../project-event-source-outbox';
import { resolveProjectEventSourceOutboxConfig } from '../project-event-source-outbox-contract';
import type {
  CredentialLimitDispatchOutcome,
  CredentialLimitLevel,
  CredentialLimitRuntimeConfig,
  CredentialLimitTransition,
  CredentialLimitWindowRow,
  SanitizedCredentialLimitObservation,
} from './types';
import { nullableNumberEquals } from './values';

const MILLIS_PER_DAY = 24 * 60 * 60_000;
const ACTIVE_SOURCE_OUTBOX_STATES = "'pending', 'processing', 'retryable_failed'";

type D1RunLike = { meta?: { changes?: number } };

type SourceIntentRow = {
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
  admittedEventId: string | null;
  admissionOutcome: string | null;
};

export type CredentialLimitAdmissionCaptureResult =
  | { outcome: 'created'; admission: SourceIntentRow }
  | { outcome: 'duplicate_replay'; admission: SourceIntentRow }
  | { outcome: 'conflict'; admission: SourceIntentRow | null }
  | { outcome: 'capacity' }
  | { outcome: 'stale' }
  | { outcome: 'duplicate' };

function changeCount(result: unknown): number {
  const changes = (result as D1RunLike | undefined)?.meta?.changes;
  return typeof changes === 'number' ? changes : 0;
}

function withoutProjectId(
  input: AdmitProjectEventInput
): Omit<AdmitProjectEventInput, 'projectId'> {
  const { projectId, ...event } = input;
  void projectId;
  return event;
}

function eventPayloadJson(input: AdmitProjectEventInput): string {
  return canonicalJson(withoutProjectId(input) as unknown as ProjectEventJsonValue);
}

function expiresAtIso(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export async function purgeExpiredCredentialLimitWindows(
  env: Env,
  now: number,
  config: Pick<CredentialLimitRuntimeConfig, 'admissionRetryBatchSize' | 'admissionRetentionDays'>,
  projectId?: string | null
): Promise<number> {
  const cutoff = now - config.admissionRetentionDays * MILLIS_PER_DAY;
  const projectFilter = projectId ? 'AND project_id = ?' : '';
  const result = await env.DATABASE.prepare(
    `DELETE FROM credential_limit_windows
      WHERE rowid IN (
        SELECT rowid
          FROM credential_limit_windows
         WHERE updated_at <= ?
           ${projectFilter}
         ORDER BY updated_at ASC, project_id ASC, credential_reference ASC, window_type ASC
         LIMIT ?
      )`
  )
    .bind(
      ...(projectId
        ? [cutoff, projectId, config.admissionRetryBatchSize]
        : [cutoff, config.admissionRetryBatchSize])
    )
    .run();
  return changeCount(result);
}

export async function loadWindow(
  env: Env,
  observation: Pick<
    SanitizedCredentialLimitObservation,
    'projectId' | 'credentialReference' | 'windowType'
  >
): Promise<CredentialLimitWindowRow | null> {
  return env.DATABASE.prepare(
    `SELECT status, last_event_level, utilization_percent, limit_amount, remaining_amount,
            window_minutes, resets_at, observed_at, stale_sample_count, duplicate_sample_count,
            last_event_delivery_key
       FROM credential_limit_windows
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(observation.projectId, observation.credentialReference, observation.windowType)
    .first<CredentialLimitWindowRow>();
}

export async function updateStaleSample(
  env: Env,
  observation: Pick<
    SanitizedCredentialLimitObservation,
    'projectId' | 'credentialReference' | 'windowType'
  >
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_windows
        SET stale_sample_count = MIN(stale_sample_count + 1, 2147483647),
            updated_at = ?
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(
      Date.now(),
      observation.projectId,
      observation.credentialReference,
      observation.windowType
    )
    .run();
}

export async function updateDuplicateSample(
  env: Env,
  observation: Pick<
    SanitizedCredentialLimitObservation,
    'projectId' | 'credentialReference' | 'windowType'
  >
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_windows
        SET duplicate_sample_count = MIN(duplicate_sample_count + 1, 2147483647),
            updated_at = ?
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(
      Date.now(),
      observation.projectId,
      observation.credentialReference,
      observation.windowType
    )
    .run();
}

export function sameSample(
  row: CredentialLimitWindowRow,
  observation: SanitizedCredentialLimitObservation,
  level: CredentialLimitLevel
): boolean {
  return (
    row.status === observation.status &&
    row.last_event_level === level &&
    nullableNumberEquals(row.utilization_percent, observation.utilizationPercent) &&
    nullableNumberEquals(row.limit_amount, observation.limitAmount) &&
    nullableNumberEquals(row.remaining_amount, observation.remainingAmount) &&
    nullableNumberEquals(row.window_minutes, observation.windowMinutes) &&
    nullableNumberEquals(row.resets_at, observation.resetsAt)
  );
}

export async function upsertCredentialLimitWindow(
  env: Env,
  observation: SanitizedCredentialLimitObservation,
  level: CredentialLimitLevel,
  deliveryKey: string | null
): Promise<number> {
  const now = Date.now();
  const result = await env.DATABASE.prepare(windowUpsertValuesSql())
    .bind(...windowUpsertBindings(observation, level, deliveryKey, now))
    .run();
  return changeCount(result);
}

async function readSourceIntentByDeliveryKey(
  env: Env,
  projectId: string,
  source: string,
  deliveryKey: string
): Promise<SourceIntentRow | null> {
  return env.DATABASE.prepare(
    sourceIntentSelectSql('project_id = ? AND source = ? AND delivery_key = ?')
  )
    .bind(projectId, source, deliveryKey)
    .first<SourceIntentRow>();
}

async function readSourceIntentById(env: Env, id: string): Promise<SourceIntentRow | null> {
  return env.DATABASE.prepare(sourceIntentSelectSql('id = ?')).bind(id).first<SourceIntentRow>();
}

async function supersedeOlderCredentialLimitSourceIntents(
  env: Env,
  observation: SanitizedCredentialLimitObservation,
  eventSource: string,
  currentDeliveryKey: string,
  now: number,
  limit: number
): Promise<number> {
  const result = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed',
            processing_lease_expires_at = NULL,
            claim_token = NULL,
            terminalized_at = ?,
            last_error = 'Superseded by newer credential limit window',
            updated_at = ?
      WHERE id IN (
        SELECT id
          FROM project_event_source_outbox
         WHERE project_id = ?
           AND source = ?
           AND subject_id = ?
           AND credential_limit_window_type = ?
           AND credential_limit_observed_at IS NOT NULL
           AND credential_limit_observed_at < ?
           AND delivery_key != ?
           AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES})
         ORDER BY credential_limit_observed_at ASC, id ASC
         LIMIT ?
      )`
  )
    .bind(
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      observation.projectId,
      eventSource,
      observation.credentialReference,
      observation.windowType,
      observation.observedAt,
      currentDeliveryKey,
      limit
    )
    .run();
  return changeCount(result);
}

function sourceIntentSelectSql(where: string): string {
  return `SELECT id, project_id AS projectId, source, event_type AS eventType,
                 subject_type AS subjectType, subject_id AS subjectId,
                 delivery_key AS deliveryKey, payload_fingerprint AS payloadFingerprint,
                 event_payload_json AS eventPayloadJson, state,
                 attempt_count AS attemptCount, max_attempts AS maxAttempts,
                 expires_at AS expiresAt, admitted_event_id AS admittedEventId,
                 admission_outcome AS admissionOutcome
            FROM project_event_source_outbox
           WHERE ${where}
           LIMIT 1`;
}

export async function captureCredentialLimitEventAdmission(
  env: Env,
  observation: SanitizedCredentialLimitObservation,
  level: CredentialLimitLevel,
  eventInput: AdmitProjectEventInput,
  _transition: CredentialLimitTransition,
  config: CredentialLimitRuntimeConfig
): Promise<CredentialLimitAdmissionCaptureResult> {
  const existingIntent = await readSourceIntentByDeliveryKey(
    env,
    observation.projectId,
    eventInput.source,
    eventInput.deliveryKey
  );
  if (existingIntent) {
    return existingIntent.payloadFingerprint === eventInput.payloadFingerprint
      ? { outcome: 'duplicate_replay', admission: existingIntent }
      : { outcome: 'conflict', admission: existingIntent };
  }

  const now = Date.now();
  await purgeExpiredCredentialLimitWindows(env, now, config, observation.projectId);

  const sourceConfig = resolveProjectEventSourceOutboxConfig(env);
  const intentId = ulid();
  const nowDate = new Date(now);
  const nowIso = nowDate.toISOString();
  const insertIntent = env.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_event_source_outbox
      (id, project_id, source, event_type, subject_type, subject_id, delivery_key,
       payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
       next_attempt_at, expires_at, created_at, updated_at,
       credential_limit_window_type, credential_limit_observed_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*)
          FROM project_event_source_outbox
         WHERE project_id = ?
           AND source = ?
           AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES})
           AND expires_at > ?
      ) < ?
        AND NOT EXISTS (
          SELECT 1
            FROM credential_limit_windows
           WHERE project_id = ?
             AND credential_reference = ?
             AND window_type = ?
             AND observed_at >= ?
        )`
  ).bind(
    intentId,
    eventInput.projectId,
    eventInput.source,
    eventInput.eventType,
    eventInput.subject.type,
    eventInput.subject.id,
    eventInput.deliveryKey,
    eventInput.payloadFingerprint,
    eventPayloadJson(eventInput),
    sourceConfig.maxAttempts,
    nowIso,
    expiresAtIso(nowDate, sourceConfig.ttlMs),
    nowIso,
    nowIso,
    observation.windowType,
    observation.observedAt,
    eventInput.projectId,
    eventInput.source,
    nowIso,
    config.admissionMaxActivePerProject,
    observation.projectId,
    observation.credentialReference,
    observation.windowType,
    observation.observedAt
  );
  const upsertWindow = env.DATABASE.prepare(windowUpsertAfterIntentSql()).bind(
    ...windowUpsertBindings(observation, level, eventInput.deliveryKey, now),
    intentId,
    eventInput.payloadFingerprint
  );

  let results: unknown[];
  try {
    results = (await env.DATABASE.batch([insertIntent, upsertWindow])) as unknown[];
  } catch (error) {
    const raced = await readSourceIntentByDeliveryKey(
      env,
      observation.projectId,
      eventInput.source,
      eventInput.deliveryKey
    );
    if (!raced) throw error;
    return raced.payloadFingerprint === eventInput.payloadFingerprint
      ? { outcome: 'duplicate_replay', admission: raced }
      : { outcome: 'conflict', admission: raced };
  }

  const insertedIntent = changeCount(results[0]) === 1;
  const advancedWindow = changeCount(results[1]) === 1;
  if (!insertedIntent || !advancedWindow) {
    if (insertedIntent) {
      await markSourceIntentSuperseded(env, intentId, now, 'Credential limit window CAS lost');
      const current = await loadWindow(env, observation);
      if (current && current.observed_at >= observation.observedAt) {
        return sameSample(current, observation, level)
          ? { outcome: 'duplicate' }
          : { outcome: 'stale' };
      }
      return { outcome: 'capacity' };
    }
    const raced = await readSourceIntentByDeliveryKey(
      env,
      observation.projectId,
      eventInput.source,
      eventInput.deliveryKey
    );
    if (raced) {
      return raced.payloadFingerprint === eventInput.payloadFingerprint
        ? { outcome: 'duplicate_replay', admission: raced }
        : { outcome: 'conflict', admission: raced };
    }
    const current = await loadWindow(env, observation);
    if (current && current.observed_at >= observation.observedAt) {
      return sameSample(current, observation, level)
        ? { outcome: 'duplicate' }
        : { outcome: 'stale' };
    }
    return { outcome: 'capacity' };
  }

  await supersedeOlderCredentialLimitSourceIntents(
    env,
    observation,
    eventInput.source,
    eventInput.deliveryKey,
    now,
    config.admissionRetryBatchSize
  );
  const admission = await readSourceIntentById(env, intentId);
  if (!admission) throw new Error('credential limit source intent was not readable after capture');
  return { outcome: 'created', admission };
}

async function markSourceIntentSuperseded(
  env: Env,
  id: string,
  now: number,
  reason: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed',
            processing_lease_expires_at = NULL,
            claim_token = NULL,
            terminalized_at = ?,
            last_error = ?,
            updated_at = ?
      WHERE id = ?
        AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES})`
  )
    .bind(new Date(now).toISOString(), reason, new Date(now).toISOString(), id)
    .run();
}

export async function dispatchCredentialLimitAdmission(
  env: Env,
  admission: SourceIntentRow
): Promise<CredentialLimitDispatchOutcome> {
  const result = await admitProjectEventSourceIntentById(env, admission.id);
  return credentialDispatchOutcome(result ?? { intentId: admission.id, state: admission.state });
}

function credentialDispatchOutcome(
  result: Pick<ProjectEventSourceAdmissionResult, 'state' | 'admissionOutcome'>
): CredentialLimitDispatchOutcome {
  if (result.state === 'admitted') return result.admissionOutcome ?? 'created';
  if (result.admissionOutcome === 'conflict') return 'conflict';
  if (result.state === 'expired' || result.state === 'permanent_failed') return 'failed';
  return 'deferred';
}

function windowUpsertValuesSql(): string {
  return `INSERT INTO credential_limit_windows (
        project_id, credential_reference, window_type, credential_source, provider, provider_mode,
        agent_type, user_id, workspace_id, agent_session_id, chat_session_id, source, status,
        last_event_level, utilization_percent, limit_amount, remaining_amount, window_minutes,
        resets_at, observed_at, freshness_ms, last_event_delivery_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, credential_reference, window_type) DO UPDATE SET
        credential_source = excluded.credential_source,
        provider = excluded.provider,
        provider_mode = excluded.provider_mode,
        agent_type = excluded.agent_type,
        user_id = excluded.user_id,
        workspace_id = excluded.workspace_id,
        agent_session_id = excluded.agent_session_id,
        chat_session_id = excluded.chat_session_id,
        source = excluded.source,
        status = excluded.status,
        last_event_level = excluded.last_event_level,
        utilization_percent = excluded.utilization_percent,
        limit_amount = excluded.limit_amount,
        remaining_amount = excluded.remaining_amount,
        window_minutes = excluded.window_minutes,
        resets_at = excluded.resets_at,
        observed_at = excluded.observed_at,
        freshness_ms = excluded.freshness_ms,
        last_event_delivery_key = excluded.last_event_delivery_key,
        updated_at = excluded.updated_at
      WHERE excluded.observed_at > credential_limit_windows.observed_at`;
}

function windowUpsertAfterIntentSql(): string {
  return `INSERT INTO credential_limit_windows (
        project_id, credential_reference, window_type, credential_source, provider, provider_mode,
        agent_type, user_id, workspace_id, agent_session_id, chat_session_id, source, status,
        last_event_level, utilization_percent, limit_amount, remaining_amount, window_minutes,
        resets_at, observed_at, freshness_ms, last_event_delivery_key, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1
           FROM project_event_source_outbox
          WHERE id = ?
            AND payload_fingerprint = ?
            AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES}, 'admitted')
       )
      ON CONFLICT(project_id, credential_reference, window_type) DO UPDATE SET
        credential_source = excluded.credential_source,
        provider = excluded.provider,
        provider_mode = excluded.provider_mode,
        agent_type = excluded.agent_type,
        user_id = excluded.user_id,
        workspace_id = excluded.workspace_id,
        agent_session_id = excluded.agent_session_id,
        chat_session_id = excluded.chat_session_id,
        source = excluded.source,
        status = excluded.status,
        last_event_level = excluded.last_event_level,
        utilization_percent = excluded.utilization_percent,
        limit_amount = excluded.limit_amount,
        remaining_amount = excluded.remaining_amount,
        window_minutes = excluded.window_minutes,
        resets_at = excluded.resets_at,
        observed_at = excluded.observed_at,
        freshness_ms = excluded.freshness_ms,
        last_event_delivery_key = excluded.last_event_delivery_key,
        updated_at = excluded.updated_at
      WHERE excluded.observed_at > credential_limit_windows.observed_at`;
}

function windowUpsertBindings(
  observation: SanitizedCredentialLimitObservation,
  level: CredentialLimitLevel,
  deliveryKey: string | null,
  now: number
): unknown[] {
  return [
    observation.projectId,
    observation.credentialReference,
    observation.windowType,
    observation.credentialSource,
    observation.provider,
    observation.providerMode,
    observation.agentType,
    observation.userId,
    observation.workspaceId,
    observation.agentSessionId,
    observation.chatSessionId,
    observation.source,
    observation.status,
    level,
    observation.utilizationPercent,
    observation.limitAmount,
    observation.remainingAmount,
    observation.windowMinutes,
    observation.resetsAt,
    observation.observedAt,
    observation.freshnessMs,
    deliveryKey,
    now,
    now,
  ];
}
