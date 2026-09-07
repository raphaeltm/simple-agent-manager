import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { createModuleLogger } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';
import {
  assertProjectEventSourceOutboxCaptureMatchesInput,
  PROJECT_EVENT_SOURCE_OUTBOX_ACTIVE_STATES,
  PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_STATES,
  type ProjectEventSourceAdmissionResult,
  ProjectEventSourceAdmissionTimeoutError,
  projectEventSourceAdmissionTimeoutMs,
  type ProjectEventSourceAdmissionTiming,
  type ProjectEventSourceOutboxActiveState,
  projectEventSourceOutboxClockFrom,
  projectEventSourceOutboxErrorText,
  type ProjectEventSourceOutboxInsertOptions,
  projectEventSourceOutboxInsertValues,
  type ProjectEventSourceOutboxIntent,
  projectEventSourceOutboxNextRetryAt,
  type ProjectEventSourceOutboxReadByIdInput,
  projectEventSourceOutboxReplayConflict,
  type ProjectEventSourceOutboxState,
  type ProjectEventSourceOutboxStats,
  type ProjectEventSourceOutboxSupersedeInput,
  type ProjectEventSourceOutboxTerminalState,
  resolveProjectEventSourceOutboxConfig,
  withProjectEventSourceAdmissionTimeout,
} from './project-event-source-outbox-contract';
import {
  loadProjectEventSourceIntentByClaim,
  loadProjectEventSourceIntentByDelivery,
  loadProjectEventSourceIntentByIdentity,
  loadProjectEventSourceIntentByInternalId,
} from './project-event-source-outbox-storage';

export type {
  ProjectEventSourceAdmissionResult,
  ProjectEventSourceAdmissionTiming,
  ProjectEventSourceOutboxCaptureGuard,
  ProjectEventSourceOutboxConfig,
  ProjectEventSourceOutboxInsertOptions,
  ProjectEventSourceOutboxIntent,
  ProjectEventSourceOutboxReadByIdInput,
  ProjectEventSourceOutboxState,
  ProjectEventSourceOutboxStats,
  ProjectEventSourceOutboxSupersedeInput,
} from './project-event-source-outbox-contract';
export {
  projectEventSourceOutboxPayload,
  projectEventSourceOutboxReplayConflict,
  resolveProjectEventSourceOutboxConfig,
} from './project-event-source-outbox-contract';

const log = createModuleLogger('project_event_source_outbox');
const ACTIVE_STATES = PROJECT_EVENT_SOURCE_OUTBOX_ACTIVE_STATES;
const TERMINAL_STATES = PROJECT_EVENT_SOURCE_OUTBOX_TERMINAL_STATES;
const CANDIDATE_ADMISSION_MIN_OUTBOX_MUTATIONS = 2;

export function projectEventSourceOutboxInsertStatement(
  env: Env,
  input: AdmitProjectEventInput,
  options: ProjectEventSourceOutboxInsertOptions = {}
): D1PreparedStatement {
  if (options.capture) assertProjectEventSourceOutboxCaptureMatchesInput(input, options.capture);
  const values = projectEventSourceOutboxInsertValues(env, input, options);
  const columns = `(id, project_id, source, event_type, subject_type, subject_id, delivery_key,
       payload_fingerprint, event_payload_json, state, attempt_count, max_attempts,
       next_attempt_at, expires_at, created_at, updated_at)`;
  if (options.capture?.kind === 'task_terminal_transition') {
    const guard = options.capture;
    return env.DATABASE.prepare(
      `INSERT OR IGNORE INTO project_event_source_outbox ${columns}
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM tasks
           WHERE id = ? AND project_id = ? AND terminal_transition_id = ?
       )`
    ).bind(...values, guard.taskId, guard.projectId, guard.terminalTransitionId);
  }
  if (options.capture?.kind === 'credential_limit_window_transition') {
    const guard = options.capture;
    const credentialColumns = `${columns.slice(0, -1)},
       credential_limit_window_type, credential_limit_observed_at)`;
    return env.DATABASE.prepare(
      `INSERT OR IGNORE INTO project_event_source_outbox ${credentialColumns}
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?
        WHERE (
          SELECT COUNT(*) FROM (
            SELECT id FROM project_event_source_outbox
             WHERE project_id = ? AND source = ?
               AND state IN ('pending', 'processing', 'retryable_failed')
               AND expires_at > ?
             LIMIT ?
          )
        ) < ?
          AND NOT EXISTS (
            SELECT 1 FROM credential_limit_windows
             WHERE project_id = ?
               AND credential_reference = ?
               AND window_type = ?
               AND observed_at >= ?
        )`
    ).bind(
      ...values,
      guard.windowType,
      guard.observedAt,
      input.projectId,
      input.source,
      values[10],
      guard.maxActiveIntentsPerProject,
      guard.maxActiveIntentsPerProject,
      guard.projectId,
      guard.credentialReference,
      guard.windowType,
      guard.observedAt
    );
  }
  return env.DATABASE.prepare(
    `INSERT OR IGNORE INTO project_event_source_outbox ${columns}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
  ).bind(...values);
}

export async function readProjectEventSourceIntentByDelivery(
  env: Env,
  input: Pick<AdmitProjectEventInput, 'projectId' | 'source' | 'deliveryKey'>
): Promise<ProjectEventSourceOutboxIntent | null> {
  return loadProjectEventSourceIntentByDelivery(env, input);
}

export async function readProjectEventSourceIntentById(
  env: Env,
  input: ProjectEventSourceOutboxReadByIdInput
): Promise<ProjectEventSourceOutboxIntent | null> {
  return loadProjectEventSourceIntentByIdentity(env, input);
}

export async function markProjectEventSourceIntentSuperseded(
  env: Env,
  input: ProjectEventSourceOutboxSupersedeInput
): Promise<ProjectEventSourceOutboxIntent | null> {
  const nowIso = (input.now ?? new Date()).toISOString();
  await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'permanent_failed', processing_lease_expires_at = NULL,
            claim_token = NULL, terminalized_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND source = ? AND delivery_key = ?
        AND (
          state IN ('pending', 'retryable_failed')
          OR (state = 'processing' AND processing_lease_expires_at IS NOT NULL
              AND processing_lease_expires_at <= ?)
        )`
  )
    .bind(
      nowIso,
      input.reason ?? 'Superseded by newer source observation',
      nowIso,
      input.id,
      input.projectId,
      input.source,
      input.deliveryKey,
      nowIso
    )
    .run();
  return loadProjectEventSourceIntentByIdentity(env, input);
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
        WHERE id = ? AND project_id = ? AND state IN ('pending', 'retryable_failed', 'processing')`
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
  const intentById = options.id
    ? await loadProjectEventSourceIntentByInternalId(env, options.id)
    : null;
  const intent =
    intentById && projectEventSourceOutboxReplayConflict(intentById, input) === null
      ? intentById
      : await loadProjectEventSourceIntentByDelivery(env, input);
  if (!intent) throw new Error('Project event source outbox intent was not persisted');
  const conflict = projectEventSourceOutboxReplayConflict(intent, input);
  if (conflict) {
    await markLocalReplayConflict(env, intent, input, conflict, options.now ?? new Date());
    throw new Error(`Project event source outbox delivery replay conflict: ${conflict}`);
  }
  return intent;
}

function resultFromIntent(
  intent: ProjectEventSourceOutboxIntent,
  outboxMutations = 0
): ProjectEventSourceAdmissionResult {
  return {
    intentId: intent.id,
    state: intent.state,
    admissionOutcome: intent.admissionOutcome ?? undefined,
    eventId: intent.admittedEventId ?? undefined,
    attemptCount: intent.attemptCount,
    outboxMutations,
  };
}

async function terminalizeIneligibleClaim(env: Env, id: string, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const expired = await env.DATABASE.prepare(
    `UPDATE project_event_source_outbox
        SET state = 'expired', processing_lease_expires_at = NULL, claim_token = NULL,
            terminalized_at = ?, last_error = COALESCE(last_error, 'Intent expired'), updated_at = ?
      WHERE id = ? AND state IN ('pending', 'retryable_failed', 'processing') AND expires_at <= ?`
  )
    .bind(nowIso, nowIso, id, nowIso)
    .run();
  const exhausted = await env.DATABASE.prepare(
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
  return Number(expired.meta.changes ?? 0) + Number(exhausted.meta.changes ?? 0);
}

async function claimIntent(
  env: Env,
  id: string,
  now: Date
): Promise<{ intent: ProjectEventSourceOutboxIntent | null; outboxMutations: number }> {
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
    return {
      intent: null,
      outboxMutations: await terminalizeIneligibleClaim(env, id, now),
    };
  }
  return {
    intent: await loadProjectEventSourceIntentByClaim(env, id, claimToken),
    outboxMutations: 1,
  };
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
  const current = await loadProjectEventSourceIntentByInternalId(env, intent.id);
  const outboxMutations = Number(result.meta.changes ?? 0);
  if (outboxMutations === 0 && current) return resultFromIntent(current, 0);
  return current
    ? resultFromIntent(current, outboxMutations)
    : { intentId: intent.id, state: 'permanent_failed', outboxMutations };
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
    state === 'retryable_failed'
      ? projectEventSourceOutboxNextRetryAt(now, intent.attemptCount, config)
      : now;
  return updateClaimedIntent(
    env,
    intent,
    `SET state = ?, next_attempt_at = ?, processing_lease_expires_at = NULL,
         claim_token = NULL, terminalized_at = CASE WHEN ? = 'retryable_failed' THEN NULL ELSE ? END,
         last_error = ?, updated_at = ?`,
    [
      state,
      nextAttemptAt.toISOString(),
      state,
      nowIso,
      projectEventSourceOutboxErrorText(error),
      nowIso,
    ]
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

async function admitClaimedIntent(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  clock: () => Date,
  admissionTimeoutMs?: number,
  deadlineMs?: number
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
      [clock().toISOString(), projectEventSourceOutboxErrorText(error), clock().toISOString()]
    );
  }

  try {
    const config = resolveProjectEventSourceOutboxConfig(env);
    const currentClaim = await loadProjectEventSourceIntentByClaim(
      env,
      intent.id,
      intent.claimToken ?? ''
    );
    if (!currentClaim) {
      const current = await loadProjectEventSourceIntentByInternalId(env, intent.id);
      return current ? resultFromIntent(current) : resultFromIntent(intent);
    }
    const timeoutMs = projectEventSourceAdmissionTimeoutMs(config, admissionTimeoutMs, deadlineMs);
    if (timeoutMs <= 0) {
      return markIntentFailed(env, intent, new ProjectEventSourceAdmissionTimeoutError(0), clock());
    }
    const result = await withProjectEventSourceAdmissionTimeout(
      () => projectDataService.admitProjectEvent(env, intent.projectId, payload),
      timeoutMs
    );
    const state: ProjectEventSourceOutboxState =
      result.outcome === 'conflict' ? 'permanent_failed' : 'admitted';
    const nowIso = clock().toISOString();
    return updateClaimedIntent(
      env,
      intent,
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
      error: projectEventSourceOutboxErrorText(error),
    });
    return markIntentFailed(env, intent, error, clock());
  }
}

export async function admitProjectEventSourceIntentById(
  env: Env,
  id: string,
  timing?: ProjectEventSourceAdmissionTiming
): Promise<ProjectEventSourceAdmissionResult | null> {
  const clock = projectEventSourceOutboxClockFrom(timing);
  const claim = await claimIntent(env, id, clock());
  if (!claim.intent) {
    const existing = await loadProjectEventSourceIntentByInternalId(env, id);
    return existing ? resultFromIntent(existing, claim.outboxMutations) : null;
  }
  const admissionTimeoutMs = timing instanceof Date ? undefined : timing?.admissionTimeoutMs;
  const deadlineMs = timing instanceof Date ? undefined : timing?.deadlineMs;
  const result = await admitClaimedIntent(env, claim.intent, clock, admissionTimeoutMs, deadlineMs);
  result.outboxMutations = (result.outboxMutations ?? 0) + claim.outboxMutations;
  return result;
}

export async function enqueueAndAdmitProjectEventSourceIntent(
  env: Env,
  input: AdmitProjectEventInput
): Promise<ProjectEventSourceAdmissionResult> {
  let intent: ProjectEventSourceOutboxIntent;
  try {
    intent = await enqueueProjectEventSourceIntent(env, input);
  } catch (error) {
    const existing = await loadProjectEventSourceIntentByDelivery(env, input);
    if (!existing) throw error;
    const reason = projectEventSourceOutboxReplayConflict(existing, input);
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
  if (result.state !== 'pending' && result.state !== 'processing') stats.attempted += 1;
}

export async function reconcileProjectEventSourceOutbox(
  env: Env,
  options: { limit?: number; now?: Date; clock?: () => Date } = {}
): Promise<ProjectEventSourceOutboxStats> {
  const config = resolveProjectEventSourceOutboxConfig(env);
  const limit = Math.max(1, Math.min(options.limit ?? config.batchRows, config.batchRows));
  const clock = projectEventSourceOutboxClockFrom(
    options.clock ? { clock: options.clock } : options.now
  );
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
    outboxMutations: 0,
    hasMore: false,
  };
  let remainingMutations = limit;
  const spend = (changedRows: number) => {
    const before = remainingMutations;
    remainingMutations = Math.max(0, remainingMutations - changedRows);
    stats.outboxMutations += changedRows;
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
      remainingMutations
    );
    stats.expired += changed;
    spend(changed);
    if (remainingMutations <= 0 || Date.now() >= deadline) return stats;
  }
  for (const state of ACTIVE_STATES) {
    const changed = await terminalizeExhaustedRows(env, state, clock(), remainingMutations);
    stats.permanentFailed += changed;
    spend(changed);
    if (remainingMutations <= 0 || Date.now() >= deadline) return stats;
  }
  if (config.terminalRetentionMs >= 0) {
    const cutoff = new Date(clock().getTime() - config.terminalRetentionMs).toISOString();
    for (const state of TERMINAL_STATES) {
      const backfilled = await backfillLegacyTerminalizedRows(
        env,
        state,
        clock().toISOString(),
        remainingMutations
      );
      spend(backfilled);
      if (remainingMutations <= 0 || Date.now() >= deadline) return stats;
      const deleted = await deleteTerminalRows(env, state, cutoff, remainingMutations);
      stats.terminalDeleted += deleted;
      spend(deleted);
      if (remainingMutations <= 0 || Date.now() >= deadline) return stats;
    }
  }

  const candidateLimit = Math.floor(remainingMutations / CANDIDATE_ADMISSION_MIN_OUTBOX_MUTATIONS);
  if (candidateLimit <= 0) {
    stats.hasMore = true;
    return stats;
  }
  const ids = await selectCandidateIds(env, clock().toISOString(), candidateLimit);
  stats.hasMore = stats.hasMore || ids.length >= candidateLimit;
  for (const id of ids) {
    if (remainingMutations < CANDIDATE_ADMISSION_MIN_OUTBOX_MUTATIONS || Date.now() >= deadline) {
      stats.hasMore = true;
      break;
    }
    const result = await admitProjectEventSourceIntentById(env, id, {
      clock,
      deadlineMs: deadline,
    });
    spend(result?.outboxMutations ?? 0);
    if (result?.state === 'retryable_failed') {
      const current = await loadProjectEventSourceIntentByInternalId(env, id);
      if (current?.claimToken === null && current.lastError?.includes('timed out'))
        stats.timedOut += 1;
    }
    countResult(stats, result);
  }
  return stats;
}
