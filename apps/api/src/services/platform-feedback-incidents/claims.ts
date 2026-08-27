import type { Env } from '../../env';
import { ulid } from '../../lib/ulid';
import { getIncidentConfig, type IncidentConfig } from '../platform-feedback-incident-config';
import {
  normalizeIncidentResolutionReferences,
  requireIncidentResolutionContract,
  serializeIncidentResolutionReferences,
} from '../platform-feedback-incident-resolution-references';
import type { IncidentQueueState } from './constants';
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

export async function reclaimExpiredIncidentClaims(
  env: Env,
  now: number = Date.now()
): Promise<number> {
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'pending',
      incident_claim_token = NULL,
      incident_claim_expires_at = NULL,
      incident_claimed_by_task_id = NULL,
      incident_claimed_at = NULL,
      queued_at = COALESCE(queued_at, ?),
      updated_at = CURRENT_TIMESTAMP
     WHERE queue_state = 'claimed'
       AND rejected_at IS NULL
       AND incident_claim_expires_at IS NOT NULL
       AND incident_claim_expires_at < ?`
  )
    .bind(now, now)
    .run();
  return result.meta.changes ?? 0;
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
       AND queue_state IN ('pending', 'dispatched', 'claimed')
       AND rejected_at IS NULL
       AND (incident_claim_expires_at IS NULL OR incident_claim_expires_at < ?)`
  )
    .bind(claimToken, leaseExpiresAt, taskId, now, signature, now)
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
