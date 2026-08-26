import type { Env } from '../../env';
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { getIncidentConfig, type IncidentConfig } from '../platform-feedback-incident-config';
import { staleSingletonBefore } from './selection';
import { placeholders } from './state';

export async function expireStaleIncidents(
  env: Env,
  now: number = Date.now(),
  config: IncidentConfig = getIncidentConfig(env)
): Promise<number> {
  const staleSingletonCutoff = staleSingletonBefore(now, config);
  const staleSingletonLimit = Math.min(
    config.staleSingletonExpiryBatchSize,
    D1_MAX_BOUND_PARAMETERS - 2
  );
  const staleSingletons = await env.DATABASE.prepare(
    `SELECT signature FROM platform_feedback_triages
     WHERE queue_state = 'pending'
       AND rejected_at IS NULL
       AND occurrence_count = 1
       AND last_seen_at < ?
     ORDER BY last_seen_at ASC, signature ASC
     LIMIT ?`
  )
    .bind(staleSingletonCutoff, staleSingletonLimit)
    .all<{ signature: string }>();

  const staleSingletonSignatures = (staleSingletons.results ?? []).map((row) => row.signature);
  let singletonExpiryChanges = 0;
  if (staleSingletonSignatures.length > 0) {
    const singletonExpiry = await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET queue_state = 'expired', expired_at = ?,
        dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
        incident_claim_token = NULL, incident_claim_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
       WHERE signature IN (${placeholders(staleSingletonSignatures)})
         AND queue_state = 'pending'
         AND rejected_at IS NULL
         AND occurrence_count = 1
         AND last_seen_at < ?`
    )
      .bind(now, ...staleSingletonSignatures, staleSingletonCutoff)
      .run();
    singletonExpiryChanges = singletonExpiry.meta.changes ?? 0;
  }

  const expiredBefore = now - config.maxAgeMs;
  const maxAgeExpiry = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'expired', expired_at = ?,
      dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
      incident_claim_token = NULL, incident_claim_expires_at = NULL,
      updated_at = CURRENT_TIMESTAMP
     WHERE queue_state IN ('pending', 'dispatched', 'claimed')
       AND queued_at IS NOT NULL
       AND queued_at < ?`
  )
    .bind(now, expiredBefore)
    .run();
  return singletonExpiryChanges + (maxAgeExpiry.meta.changes ?? 0);
}
