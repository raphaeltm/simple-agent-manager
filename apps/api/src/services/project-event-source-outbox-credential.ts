import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';
import { CREDENTIAL_LIMIT_EVENT_SOURCE } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type { ProjectEventSourceOutboxIntent } from './project-event-source-outbox-contract';

function credentialLimitWindowFromIntent(
  intent: ProjectEventSourceOutboxIntent,
  payload: Omit<AdmitProjectEventInput, 'projectId'>
): { windowType: string; observedAt: number } | null {
  if (intent.source !== CREDENTIAL_LIMIT_EVENT_SOURCE) return null;
  if (intent.credentialLimitWindowType && typeof intent.credentialLimitObservedAt === 'number') {
    return {
      windowType: intent.credentialLimitWindowType,
      observedAt: intent.credentialLimitObservedAt,
    };
  }
  const metadata = payload.metadata;
  const windowType =
    metadata && typeof metadata.windowType === 'string' ? metadata.windowType : null;
  const observedAt =
    metadata && typeof metadata.observedAt === 'number' ? metadata.observedAt : null;
  if (!windowType || observedAt === null) return null;
  return { windowType, observedAt };
}

export async function credentialLimitIntentSuperseded(
  env: Env,
  intent: ProjectEventSourceOutboxIntent,
  payload: Omit<AdmitProjectEventInput, 'projectId'>
): Promise<boolean> {
  const window = credentialLimitWindowFromIntent(intent, payload);
  if (!window) return false;
  const newer = await env.DATABASE.prepare(
    `SELECT 1
       FROM credential_limit_windows
      WHERE project_id = ?
        AND credential_reference = ?
        AND window_type = ?
        AND observed_at > ?
        AND (last_event_delivery_key IS NULL OR last_event_delivery_key != ?)
      LIMIT 1`
  )
    .bind(
      intent.projectId,
      intent.subjectId,
      window.windowType,
      window.observedAt,
      intent.deliveryKey
    )
    .first<{ '1': number }>();
  return Boolean(newer);
}

export function credentialLimitAdmissionGuard(
  intent: ProjectEventSourceOutboxIntent,
  payload: Omit<AdmitProjectEventInput, 'projectId'>
): { sql: string; values: readonly unknown[] } | null {
  const window = credentialLimitWindowFromIntent(intent, payload);
  if (!window) return null;
  return {
    sql: `AND NOT EXISTS (
      SELECT 1
        FROM credential_limit_windows
       WHERE project_id = ?
         AND credential_reference = ?
         AND window_type = ?
         AND observed_at > ?
         AND (last_event_delivery_key IS NULL OR last_event_delivery_key != ?)
    )`,
    values: [
      intent.projectId,
      intent.subjectId,
      window.windowType,
      window.observedAt,
      intent.deliveryKey,
    ],
  };
}

export function credentialLimitSupersededUpdate(now: Date): {
  sqlSet: string;
  values: readonly unknown[];
} {
  return {
    sqlSet: `SET state = 'permanent_failed', processing_lease_expires_at = NULL,
         claim_token = NULL, terminalized_at = ?,
         last_error = 'Superseded by newer credential limit window before admission',
         updated_at = ?`,
    values: [now.toISOString(), now.toISOString()],
  };
}
