import type { Env } from '../../env';
import { getIncidentConfig, type IncidentConfig } from '../platform-feedback-incident-config';

export async function expireStaleIncidents(
  env: Env,
  now: number = Date.now(),
  config: IncidentConfig = getIncidentConfig(env)
): Promise<number> {
  const expiredBefore = now - config.maxAgeMs;
  const result = await env.DATABASE.prepare(
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
  return result.meta.changes ?? 0;
}
