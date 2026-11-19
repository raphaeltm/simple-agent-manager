import type { Env } from '../../env';
import { ulid } from '../../lib/ulid';
import { getIncidentConfig, type IncidentConfig } from '../platform-feedback-incident-config';
import {
  normalizeIncidentResolutionReferences,
  requireIncidentResolutionContract,
  serializeIncidentResolutionReferences,
} from '../platform-feedback-incident-resolution-references';
import { type IncidentQueueState, TERMINAL_TASK_STATUS_SQL } from './constants';
import { sanitizeText } from './text';
import type { ResolveIncidentOptions } from './types';

function resolveIncidentOptions(
  env: Env,
  nowOrOptions: number | ResolveIncidentOptions | undefined,
  fallbackConfig: IncidentConfig | undefined
): Required<Pick<ResolveIncidentOptions, 'config'>> &
  Pick<ResolveIncidentOptions, 'now' | 'resolutionReferences'> {
  if (typeof nowOrOptions === 'object' && nowOrOptions !== null) {
    return {
      now: nowOrOptions.now ?? Date.now(),
      config: nowOrOptions.config ?? fallbackConfig ?? getIncidentConfig(env),
      resolutionReferences: nowOrOptions.resolutionReferences,
    };
  }
  return {
    now: nowOrOptions ?? Date.now(),
    config: fallbackConfig ?? getIncidentConfig(env),
    resolutionReferences: undefined,
  };
}

// Sleeping is eligible only for releasing incident ownership, never for stopping
// its task/runtime. An active investigation keeps its claim until the age ceiling.
const activeClaimOwner = (table: string) => `EXISTS (
  SELECT 1 FROM tasks owner WHERE owner.id = ${table}.incident_claimed_by_task_id
    AND owner.status NOT IN (${TERMINAL_TASK_STATUS_SQL}, 'sleeping')
)`;

async function renewActiveClaim(
  env: Env,
  ageOrigin: number,
  fence: string,
  identity: (string | number | null)[],
  now: number,
  config: IncidentConfig
): Promise<void> {
  // Keep the existing CAS token usable for resolveIncident, without moving
  // the incident's original age ceiling on every renewal.
  const expiry = Math.min(now + config.agentLeaseTtlMs, ageOrigin + config.maxAgeMs);
  if (expiry <= now) return; // expireStaleIncidents owns the age ceiling.
  await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET incident_claim_expires_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE ${fence} AND ${activeClaimOwner('platform_feedback_triages')}`
  )
    .bind(expiry, ...identity)
    .run();
}

export async function reclaimExpiredIncidentClaims(
  env: Env,
  now: number = Date.now(),
  config: IncidentConfig = getIncidentConfig(env)
): Promise<number> {
  const expired = await env.DATABASE.prepare(
    `SELECT signature, incident_claim_token, incident_claim_expires_at, dispatch_attempts,
      ${activeClaimOwner('triage')} AS owner_active,
      COALESCE(queued_at, incident_claimed_at, first_seen_at) AS age_origin
     FROM platform_feedback_triages triage
     WHERE queue_state = 'claimed' AND rejected_at IS NULL
       AND incident_claim_expires_at < ?
     ORDER BY incident_claim_expires_at ASC, signature ASC LIMIT ?`
  )
    .bind(now, config.reclaimLimit)
    .all<{
      signature: string;
      incident_claim_token: string | null;
      incident_claim_expires_at: number;
      dispatch_attempts: number;
      owner_active: number;
      age_origin: number;
    }>();
  let requeued = 0;
  for (const row of expired.results ?? []) {
    const fence = `signature = ? AND queue_state = 'claimed' AND rejected_at IS NULL
      AND incident_claim_token IS ? AND incident_claim_expires_at = ? AND dispatch_attempts = ?`;
    const identity = [
      row.signature,
      row.incident_claim_token,
      row.incident_claim_expires_at,
      row.dispatch_attempts,
    ];
    if (row.owner_active) {
      await renewActiveClaim(env, row.age_origin, fence, identity, now, config);
      continue;
    }
    const attempts = row.dispatch_attempts + 1;
    const exhausted = attempts >= config.maxDispatchAttempts;
    const reason = exhausted
      ? 'incident triage attempts exhausted without resolution after claim expiry'
      : 'incident claim expired without resolution; retry queued';
    const result = await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET queue_state = ?, dispatch_attempts = ?,
        rejected_at = ?, resolution_note = ?, last_failure_reason = ?, last_failed_at = ?,
        incident_claim_token = NULL, incident_claim_expires_at = NULL,
        incident_claimed_by_task_id = NULL, incident_claimed_at = NULL,
        dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
        dispatched_trigger_id = NULL, dispatched_execution_id = NULL, dispatched_task_id = NULL,
        queued_at = COALESCE(queued_at, ?), updated_at = CURRENT_TIMESTAMP
       WHERE ${fence} AND NOT ${activeClaimOwner('platform_feedback_triages')}`
    )
      .bind(
        exhausted ? 'rejected' : 'pending',
        attempts,
        exhausted ? now : null,
        exhausted ? reason : null,
        reason,
        now,
        now,
        ...identity
      )
      .run();
    if (!exhausted) requeued += result.meta.changes ?? 0;
  }
  return requeued;
}

export async function claimIncident(
  env: Env,
  signature: string,
  taskId: string,
  now: number = Date.now(),
  config: IncidentConfig = getIncidentConfig(env)
): Promise<{ claimToken: string; leaseExpiresAt: number } | null> {
  const claimToken = ulid();
  const leaseExpiresAt = now + config.agentLeaseTtlMs;
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'claimed',
      incident_claim_token = ?, incident_claim_expires_at = ?,
      incident_claimed_by_task_id = ?, incident_claimed_at = ?,
      updated_at = CURRENT_TIMESTAMP
     WHERE signature = ?
       AND queue_state IN ('pending', 'dispatched')
       AND dispatch_attempts < ?
       AND rejected_at IS NULL
       AND (incident_claim_expires_at IS NULL OR incident_claim_expires_at < ?)`
  )
    .bind(claimToken, leaseExpiresAt, taskId, now, signature, config.maxDispatchAttempts, now)
    .run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return { claimToken, leaseExpiresAt };
}

export async function resolveIncident(
  env: Env,
  signature: string,
  claimToken: string,
  outcome: Extract<IncidentQueueState, 'resolved' | 'rejected'>,
  taskId: string,
  note: string,
  nowOrOptions: number | ResolveIncidentOptions = Date.now(),
  config?: IncidentConfig
): Promise<boolean> {
  const options = resolveIncidentOptions(env, nowOrOptions, config);
  const now = options.now ?? Date.now();
  const incidentConfig = options.config;
  const sanitizedNote = sanitizeText(note, incidentConfig.resolutionNoteMaxLength);
  const resolutionReferences = normalizeIncidentResolutionReferences(
    options.resolutionReferences,
    incidentConfig.resolutionNoteMaxLength
  );
  requireIncidentResolutionContract(outcome, sanitizedNote, resolutionReferences);
  const serializedReferences = serializeIncidentResolutionReferences(resolutionReferences);
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = ?,
      resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
      resolved_by_task_id = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_by_task_id END,
      rejected_at = CASE WHEN ? = 'rejected' THEN COALESCE(rejected_at, ?) ELSE rejected_at END,
      resolution_note = ?,
      resolution_references = ?,
      incident_claim_token = NULL, incident_claim_expires_at = NULL,
      incident_claimed_by_task_id = NULL, incident_claimed_at = NULL,
      dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
     WHERE signature = ?
       AND queue_state = 'claimed'
       AND incident_claim_token = ?
       AND incident_claimed_by_task_id = ?
       AND incident_claim_expires_at >= ?`
  )
    .bind(
      outcome,
      outcome,
      now,
      outcome,
      taskId,
      outcome,
      now,
      sanitizedNote,
      serializedReferences,
      signature,
      claimToken,
      taskId,
      now
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}
