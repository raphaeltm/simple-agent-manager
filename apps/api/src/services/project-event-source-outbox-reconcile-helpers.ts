import type { Env } from '../env';
import type {
  ProjectEventSourceAdmissionResult,
  ProjectEventSourceOutboxActiveState,
  ProjectEventSourceOutboxStats,
  ProjectEventSourceOutboxTerminalState,
} from './project-event-source-outbox-contract';

export async function updateOpenRows(
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

export async function deleteTerminalRows(
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

export async function backfillLegacyTerminalizedRows(
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

export async function terminalizeExhaustedRows(
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

export async function selectCandidateIds(
  env: Env,
  nowIso: string,
  limit: number
): Promise<string[]> {
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

export function countResult(
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
