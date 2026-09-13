import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { ulid } from '../../lib/ulid';
import {
  admitProjectEventSourceIntentById,
  type ProjectEventSourceAdmissionResult,
  projectEventSourceOutboxInsertStatement,
  type ProjectEventSourceOutboxState,
} from '../project-event-source-outbox';
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

export type CredentialLimitWindowPredecessor = Pick<
  CredentialLimitWindowRow,
  'observed_at' | 'last_event_level' | 'last_event_delivery_key'
> | null;

export type CredentialLimitAdmissionCaptureResult =
  | { outcome: 'created'; admission: SourceIntentRow }
  | { outcome: 'duplicate_replay'; admission: SourceIntentRow }
  | { outcome: 'conflict'; admission: SourceIntentRow | null }
  | { outcome: 'capacity' }
  | { outcome: 'stale' }
  | { outcome: 'duplicate' }
  | { outcome: 'contended' };

function changeCount(result: unknown): number {
  const changes = (result as D1RunLike | undefined)?.meta?.changes;
  return typeof changes === 'number' ? changes : 0;
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
  deliveryKey: string | null,
  predecessor: CredentialLimitWindowPredecessor
): Promise<'advanced' | 'contended'> {
  const now = Date.now();
  if (predecessor === null) {
    const result = await env.DATABASE.prepare(windowInsertIfMissingSql())
      .bind(...windowUpsertBindings(observation, level, deliveryKey, now))
      .run();
    return changeCount(result) === 1 ? 'advanced' : 'contended';
  }

  const result = await env.DATABASE.prepare(windowUpdateFromPredecessorSql())
    .bind(
      ...windowUpdateBindings(observation, level, deliveryKey, now),
      observation.projectId,
      observation.credentialReference,
      observation.windowType,
      predecessor.observed_at,
      predecessor.last_event_level,
      predecessor.last_event_delivery_key,
      predecessor.last_event_delivery_key,
      observation.observedAt
    )
    .run();
  return changeCount(result) === 1 ? 'advanced' : 'contended';
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

async function credentialSourceOutboxCapacityFull(
  env: Env,
  eventInput: AdmitProjectEventInput,
  nowIso: string,
  config: Pick<CredentialLimitRuntimeConfig, 'admissionMaxActivePerProject'>
): Promise<boolean> {
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT id
           FROM project_event_source_outbox
          WHERE project_id = ?
            AND source = ?
            AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES})
            AND expires_at > ?
          LIMIT ?
       )`
  )
    .bind(eventInput.projectId, eventInput.source, nowIso, config.admissionMaxActivePerProject)
    .first<{ count: number }>();
  return Number(row?.count ?? 0) >= config.admissionMaxActivePerProject;
}

async function supersedeOlderCredentialLimitSourceIntents(
  env: Env,
  observation: SanitizedCredentialLimitObservation,
  eventSource: string,
  currentDeliveryKey: string,
  now: number,
  limit: number
): Promise<number> {
  // Once attempted, an intent may already have a canonical receipt even if its
  // response was lost. Leave live claims and retry history to the fenced outbox
  // runner, which replays the immutable envelope to canonical admission.
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
           AND state IN ('pending', 'retryable_failed')
           AND attempt_count = 0
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
  config: CredentialLimitRuntimeConfig,
  predecessor: CredentialLimitWindowPredecessor
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

  const intentId = ulid();
  const nowDate = new Date(now);
  const insertIntent = projectEventSourceOutboxInsertStatement(env, eventInput, {
    id: intentId,
    now: nowDate,
    capture: {
      kind: 'credential_limit_window_transition',
      projectId: observation.projectId,
      credentialReference: observation.credentialReference,
      windowType: observation.windowType,
      observedAt: observation.observedAt,
      previousObservedAt: predecessor?.observed_at ?? null,
      previousLevel: predecessor?.last_event_level ?? null,
      previousDeliveryKey: predecessor?.last_event_delivery_key ?? null,
      maxActiveIntentsPerProject: config.admissionMaxActivePerProject,
    },
  });
  const upsertWindow =
    predecessor === null
      ? env.DATABASE.prepare(windowInsertAfterIntentSql()).bind(
          ...windowUpsertBindings(observation, level, eventInput.deliveryKey, now),
          intentId,
          eventInput.payloadFingerprint
        )
      : env.DATABASE.prepare(windowUpdateAfterIntentSql()).bind(
          ...windowUpdateBindings(observation, level, eventInput.deliveryKey, now),
          observation.projectId,
          observation.credentialReference,
          observation.windowType,
          predecessor.observed_at,
          predecessor.last_event_level,
          predecessor.last_event_delivery_key,
          predecessor.last_event_delivery_key,
          observation.observedAt,
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
      return { outcome: 'contended' };
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
    return (await credentialSourceOutboxCapacityFull(
      env,
      eventInput,
      new Date(now).toISOString(),
      config
    ))
      ? { outcome: 'capacity' }
      : { outcome: 'contended' };
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
  // A concurrent runner may claim a freshly captured intent before this CAS-loss
  // cleanup executes. Never revoke that claim or discard an uncertain receipt.
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed',
            processing_lease_expires_at = NULL,
            claim_token = NULL,
            terminalized_at = ?,
            last_error = ?,
            updated_at = ?
      WHERE id = ?
        AND state IN ('pending', 'retryable_failed')
        AND attempt_count = 0`
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

function credentialLimitWindowColumns(): string {
  return `project_id, credential_reference, window_type, credential_source, provider, provider_mode,
        agent_type, user_id, workspace_id, agent_session_id, chat_session_id, source, status,
        last_event_level, utilization_percent, limit_amount, remaining_amount, window_minutes,
        resets_at, observed_at, freshness_ms, last_event_delivery_key, created_at, updated_at`;
}

function windowInsertIfMissingSql(): string {
  return `INSERT OR IGNORE INTO credential_limit_windows (
        ${credentialLimitWindowColumns()}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function windowInsertAfterIntentSql(): string {
  return `INSERT OR IGNORE INTO credential_limit_windows (
        ${credentialLimitWindowColumns()}
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1
           FROM project_event_source_outbox
          WHERE id = ?
            AND payload_fingerprint = ?
            AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES}, 'admitted')
       )`;
}

function windowUpdateSetSql(): string {
  return `credential_source = ?,
        provider = ?,
        provider_mode = ?,
        agent_type = ?,
        user_id = ?,
        workspace_id = ?,
        agent_session_id = ?,
        chat_session_id = ?,
        source = ?,
        status = ?,
        last_event_level = ?,
        utilization_percent = ?,
        limit_amount = ?,
        remaining_amount = ?,
        window_minutes = ?,
        resets_at = ?,
        observed_at = ?,
        freshness_ms = ?,
        last_event_delivery_key = ?,
        updated_at = ?`;
}

function windowUpdateFromPredecessorSql(): string {
  return `UPDATE credential_limit_windows
      SET ${windowUpdateSetSql()}
    WHERE project_id = ?
      AND credential_reference = ?
      AND window_type = ?
      AND observed_at = ?
      AND last_event_level = ?
      AND ((? IS NULL AND last_event_delivery_key IS NULL) OR last_event_delivery_key = ?)
      AND ? > observed_at`;
}

function windowUpdateAfterIntentSql(): string {
  return `UPDATE credential_limit_windows
      SET ${windowUpdateSetSql()}
    WHERE project_id = ?
      AND credential_reference = ?
      AND window_type = ?
      AND observed_at = ?
      AND last_event_level = ?
      AND ((? IS NULL AND last_event_delivery_key IS NULL) OR last_event_delivery_key = ?)
      AND ? > observed_at
      AND EXISTS (
        SELECT 1
          FROM project_event_source_outbox
         WHERE id = ?
           AND payload_fingerprint = ?
           AND state IN (${ACTIVE_SOURCE_OUTBOX_STATES}, 'admitted')
      )`;
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

function windowUpdateBindings(
  observation: SanitizedCredentialLimitObservation,
  level: CredentialLimitLevel,
  deliveryKey: string | null,
  now: number
): unknown[] {
  return [
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
  ];
}
