import {
  type AdmitProjectEventInput,
  isJsonRecord,
  type ProjectEventAdmissionOutcome,
  type ProjectEventJsonValue,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../project-data';
import type {
  CredentialLimitDispatchOutcome,
  CredentialLimitLevel,
  CredentialLimitRuntimeConfig,
  CredentialLimitTransition,
  CredentialLimitWindowRow,
  SanitizedCredentialLimitObservation,
} from './types';
import { nullableNumberEquals, stableStringify, truncateUtf8 } from './values';

const DISPATCH_ERROR_MAX_BYTES = 512;
const MILLIS_PER_DAY = 24 * 60 * 60_000;

type D1RunLike = { meta?: { changes?: number } };

type AdmissionRow = {
  id: string;
  project_id: string;
  credential_reference: string;
  window_type: string;
  event_source: string;
  delivery_key: string;
  payload_fingerprint: string;
  event_type: string;
  transition: CredentialLimitTransition;
  observed_at: number;
  received_at: number;
  event_payload_json: string;
  dispatch_state: 'pending' | 'delivered' | 'failed' | 'conflicted' | 'superseded';
  dispatch_outcome: CredentialLimitDispatchOutcome | null;
  dispatch_attempts: number;
  dispatch_error: string | null;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

export type CredentialLimitAdmissionCaptureResult =
  | {
      outcome: 'created';
      admission: AdmissionRow;
    }
  | {
      outcome: 'duplicate_replay';
      admission: AdmissionRow;
    }
  | {
      outcome: 'conflict';
      admission: AdmissionRow | null;
    }
  | { outcome: 'capacity' }
  | { outcome: 'stale' }
  | { outcome: 'duplicate' };

function changeCount(result: unknown): number {
  const changes = (result as D1RunLike | undefined)?.meta?.changes;
  return typeof changes === 'number' ? changes : 0;
}

function asErrorMessage(error: unknown): string {
  return truncateUtf8(error instanceof Error ? error.message : String(error), DISPATCH_ERROR_MAX_BYTES);
}

function isStoredAdmissionEventInput(input: unknown): input is AdmitProjectEventInput {
  if (!isJsonRecord(input)) return false;
  if (typeof input.projectId !== 'string') return false;
  if (typeof input.source !== 'string') return false;
  if (typeof input.eventType !== 'string') return false;
  if (typeof input.deliveryKey !== 'string') return false;
  if (typeof input.payloadFingerprint !== 'string') return false;
  if (!isJsonRecord(input.subject)) return false;
  return typeof input.subject.type === 'string' && typeof input.subject.id === 'string';
}

function expiresAt(now: number, config: Pick<CredentialLimitRuntimeConfig, 'admissionRetentionDays'>): number {
  return now + config.admissionRetentionDays * MILLIS_PER_DAY;
}

export async function purgeExpiredCredentialLimitAdmissions(
  env: Env,
  projectId: string,
  now: number,
  limit: number
): Promise<number> {
  const result = await env.DATABASE.prepare(
    `DELETE FROM credential_limit_event_admissions
      WHERE id IN (
        SELECT id
          FROM credential_limit_event_admissions
         WHERE project_id = ?
           AND expires_at <= ?
         ORDER BY expires_at ASC, id ASC
         LIMIT ?
      )`
  )
    .bind(projectId, now, limit)
    .run();
  return changeCount(result);
}

export async function loadWindow(
  env: Env,
  observation: Pick<SanitizedCredentialLimitObservation, 'projectId' | 'credentialReference' | 'windowType'>
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
  observation: Pick<SanitizedCredentialLimitObservation, 'projectId' | 'credentialReference' | 'windowType'>
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_windows
        SET stale_sample_count = MIN(stale_sample_count + 1, 2147483647),
            updated_at = ?
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(Date.now(), observation.projectId, observation.credentialReference, observation.windowType)
    .run();
}

export async function updateDuplicateSample(
  env: Env,
  observation: Pick<SanitizedCredentialLimitObservation, 'projectId' | 'credentialReference' | 'windowType'>
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_windows
        SET duplicate_sample_count = MIN(duplicate_sample_count + 1, 2147483647),
            updated_at = ?
      WHERE project_id = ? AND credential_reference = ? AND window_type = ?`
  )
    .bind(Date.now(), observation.projectId, observation.credentialReference, observation.windowType)
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
  const result = await env.DATABASE.prepare(windowUpsertSql())
    .bind(...windowUpsertBindings(observation, level, deliveryKey, now))
    .run();
  return changeCount(result);
}

async function activeAdmissionCount(env: Env, projectId: string, now: number): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT COUNT(*) AS count
       FROM credential_limit_event_admissions
      WHERE project_id = ?
        AND expires_at > ?`
  )
    .bind(projectId, now)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function readAdmissionByDeliveryKey(
  env: Env,
  projectId: string,
  source: string,
  deliveryKey: string
): Promise<AdmissionRow | null> {
  return env.DATABASE.prepare(
    `SELECT *
       FROM credential_limit_event_admissions
      WHERE project_id = ?
        AND event_source = ?
        AND delivery_key = ?
      LIMIT 1`
  )
    .bind(projectId, source, deliveryKey)
    .first<AdmissionRow>();
}

async function readAdmissionById(env: Env, id: string): Promise<AdmissionRow | null> {
  return env.DATABASE.prepare(
    `SELECT *
       FROM credential_limit_event_admissions
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<AdmissionRow>();
}

export async function captureCredentialLimitEventAdmission(
  env: Env,
  observation: SanitizedCredentialLimitObservation,
  level: CredentialLimitLevel,
  eventInput: AdmitProjectEventInput,
  transition: CredentialLimitTransition,
  config: CredentialLimitRuntimeConfig
): Promise<CredentialLimitAdmissionCaptureResult> {
  const existingAdmission = await readAdmissionByDeliveryKey(
    env,
    observation.projectId,
    eventInput.source,
    eventInput.deliveryKey
  );
  if (existingAdmission) {
    if (existingAdmission.payload_fingerprint === eventInput.payloadFingerprint) {
      return { outcome: 'duplicate_replay', admission: existingAdmission };
    }
    await markAdmissionConflict(env, existingAdmission.id, eventInput.payloadFingerprint);
    return { outcome: 'conflict', admission: await readAdmissionById(env, existingAdmission.id) };
  }

  const now = Date.now();
  await purgeExpiredCredentialLimitAdmissions(
    env,
    observation.projectId,
    now,
    config.admissionRetryBatchSize
  );

  if ((await activeAdmissionCount(env, observation.projectId, now)) >= config.admissionMaxActivePerProject) {
    return { outcome: 'capacity' };
  }

  const id = crypto.randomUUID();
  const payloadJson = stableStringify(eventInput as unknown as ProjectEventJsonValue);
  const insert = env.DATABASE.prepare(
    `INSERT INTO credential_limit_event_admissions (
        id, project_id, credential_reference, window_type, event_source, delivery_key,
        payload_fingerprint, event_type, transition, observed_at, received_at, event_payload_json,
        dispatch_state, dispatch_attempts, next_attempt_at, created_at, updated_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
          FROM credential_limit_windows
         WHERE project_id = ?
           AND credential_reference = ?
           AND window_type = ?
           AND observed_at >= ?
      )
      AND (
        SELECT COUNT(*)
          FROM credential_limit_event_admissions
         WHERE project_id = ?
           AND expires_at > ?
      ) < ?`
  ).bind(
    id,
    observation.projectId,
    observation.credentialReference,
    observation.windowType,
    eventInput.source,
    eventInput.deliveryKey,
    eventInput.payloadFingerprint,
    eventInput.eventType,
    transition,
    observation.observedAt,
    eventInput.receivedAt ?? observation.serverReceivedAt,
    payloadJson,
    now,
    now,
    now,
    expiresAt(now, config),
    observation.projectId,
    observation.credentialReference,
    observation.windowType,
    observation.observedAt,
    observation.projectId,
    now,
    config.admissionMaxActivePerProject
  );
  const upsert = env.DATABASE.prepare(windowUpsertSql()).bind(
    ...windowUpsertBindings(observation, level, eventInput.deliveryKey, now)
  );

  let results: unknown[];
  try {
    results = (await env.DATABASE.batch([insert, upsert])) as unknown[];
  } catch (error) {
    const raced = await readAdmissionByDeliveryKey(
      env,
      observation.projectId,
      eventInput.source,
      eventInput.deliveryKey
    );
    if (raced?.payload_fingerprint === eventInput.payloadFingerprint) {
      return { outcome: 'duplicate_replay', admission: raced };
    }
    if (raced) {
      await markAdmissionConflict(env, raced.id, eventInput.payloadFingerprint);
      return { outcome: 'conflict', admission: await readAdmissionById(env, raced.id) };
    }
    throw error;
  }

  if (changeCount(results[0]) !== 1) {
    const raced = await readAdmissionByDeliveryKey(
      env,
      observation.projectId,
      eventInput.source,
      eventInput.deliveryKey
    );
    if (raced?.payload_fingerprint === eventInput.payloadFingerprint) {
      return { outcome: 'duplicate_replay', admission: raced };
    }
    if (raced) {
      await markAdmissionConflict(env, raced.id, eventInput.payloadFingerprint);
      return { outcome: 'conflict', admission: await readAdmissionById(env, raced.id) };
    }
    const current = await loadWindow(env, observation);
    if (current && current.observed_at >= observation.observedAt) {
      return sameSample(current, observation, level) ? { outcome: 'duplicate' } : { outcome: 'stale' };
    }
    return { outcome: 'capacity' };
  }

  const admission = await readAdmissionById(env, id);
  if (!admission) throw new Error('credential limit admission was not readable after capture');
  return { outcome: 'created', admission };
}

export async function dispatchCredentialLimitAdmission(
  env: Env,
  admission: AdmissionRow,
  config: Pick<CredentialLimitRuntimeConfig, 'admissionMaxAttempts' | 'admissionRetryDelayMs'>
): Promise<CredentialLimitDispatchOutcome> {
  const current = await loadWindow(env, {
    projectId: admission.project_id,
    credentialReference: admission.credential_reference,
    windowType: admission.window_type,
  });
  if (!current || current.last_event_delivery_key !== admission.delivery_key) {
    await markAdmissionTerminal(env, admission.id, 'superseded', 'superseded', null);
    return 'superseded';
  }

  let eventInput: AdmitProjectEventInput;
  try {
    const parsed: unknown = JSON.parse(admission.event_payload_json);
    if (!isStoredAdmissionEventInput(parsed)) throw new Error('stored admission payload is invalid');
    eventInput = parsed;
  } catch (error) {
    await markAdmissionFailure(env, admission, 'failed', asErrorMessage(error), config);
    return 'failed';
  }

  try {
    const { projectId, ...withoutProjectId } = eventInput;
    const result = await projectDataService.admitProjectEvent(
      env,
      projectId ?? admission.project_id,
      withoutProjectId
    );
    const outcome = result.outcome as ProjectEventAdmissionOutcome;
    if (outcome === 'conflict') {
      await markAdmissionTerminal(env, admission.id, 'conflicted', outcome, null);
      return outcome;
    }
    await markAdmissionTerminal(env, admission.id, 'delivered', outcome, null);
    return outcome;
  } catch (error) {
    const outcome = isCapacityError(error) ? 'capacity' : 'failed';
    await markAdmissionFailure(env, admission, outcome, asErrorMessage(error), config);
    return outcome;
  }
}

export async function retryPendingCredentialLimitEventAdmissions(
  env: Env,
  config: CredentialLimitRuntimeConfig,
  input: { projectId?: string | null; now?: number; limit?: number } = {}
): Promise<CredentialLimitDispatchOutcome[]> {
  const now = input.now ?? Date.now();
  const limit = Math.min(input.limit ?? config.admissionRetryBatchSize, config.admissionRetryBatchSize);
  const projectFilter = input.projectId ? 'AND project_id = ?' : '';
  const rows = await env.DATABASE.prepare(
    `SELECT *
       FROM credential_limit_event_admissions
      WHERE dispatch_state IN ('pending', 'failed')
        AND dispatch_attempts < ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND expires_at > ?
        ${projectFilter}
      ORDER BY created_at ASC, id ASC
      LIMIT ?`
  )
    .bind(
      ...(
        input.projectId
          ? [config.admissionMaxAttempts, now, now, input.projectId, limit]
          : [config.admissionMaxAttempts, now, now, limit]
      )
    )
    .all<AdmissionRow>();
  const admissions = rows.results ?? [];
  const outcomes: CredentialLimitDispatchOutcome[] = [];
  for (const admission of admissions) {
    outcomes.push(await dispatchCredentialLimitAdmission(env, admission, config));
  }
  return outcomes;
}

function isCapacityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ProjectEventLimitExceededError' || error.message.toLowerCase().includes('limit'))
  );
}

async function markAdmissionConflict(
  env: Env,
  id: string,
  incomingFingerprint: string
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE credential_limit_event_admissions
        SET dispatch_state = 'conflicted',
            dispatch_outcome = 'conflict',
            dispatch_error = ?,
            updated_at = ?
      WHERE id = ?`
  )
    .bind(`incoming fingerprint ${incomingFingerprint} conflicts with captured envelope`, Date.now(), id)
    .run();
}

async function markAdmissionTerminal(
  env: Env,
  id: string,
  state: 'delivered' | 'conflicted' | 'superseded',
  outcome: CredentialLimitDispatchOutcome,
  error: string | null
): Promise<void> {
  const now = Date.now();
  await env.DATABASE.prepare(
    `UPDATE credential_limit_event_admissions
        SET dispatch_state = ?,
            dispatch_outcome = ?,
            dispatch_attempts = dispatch_attempts + 1,
            dispatch_error = ?,
            next_attempt_at = NULL,
            last_attempt_at = ?,
            updated_at = ?
      WHERE id = ?
        AND dispatch_state IN ('pending', 'failed')`
  )
    .bind(state, outcome, error, now, now, id)
    .run();
}

async function markAdmissionFailure(
  env: Env,
  admission: AdmissionRow,
  outcome: 'failed' | 'capacity',
  error: string,
  config: Pick<CredentialLimitRuntimeConfig, 'admissionMaxAttempts' | 'admissionRetryDelayMs'>
): Promise<void> {
  const now = Date.now();
  const attempts = admission.dispatch_attempts + 1;
  const retryable = attempts < config.admissionMaxAttempts && outcome !== 'capacity';
  await env.DATABASE.prepare(
    `UPDATE credential_limit_event_admissions
        SET dispatch_state = 'failed',
            dispatch_outcome = ?,
            dispatch_attempts = dispatch_attempts + 1,
            dispatch_error = ?,
            next_attempt_at = ?,
            last_attempt_at = ?,
            updated_at = ?
      WHERE id = ?
        AND dispatch_state IN ('pending', 'failed')`
  )
    .bind(
      outcome === 'failed' ? null : outcome,
      error,
      retryable ? now + config.admissionRetryDelayMs : null,
      now,
      now,
      admission.id
    )
    .run();

  log.warn('credential_limit.admission_dispatch_failed', {
    projectId: admission.project_id,
    admissionId: admission.id,
    deliveryKey: admission.delivery_key,
    outcome,
    attempts,
    retryable,
    error,
  });
}

function windowUpsertSql(): string {
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
