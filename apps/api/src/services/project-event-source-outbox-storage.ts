import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type {
  ProjectEventSourceOutboxIntent,
  ProjectEventSourceOutboxSupersedeInput,
} from './project-event-source-outbox-contract';

const SOURCE_OUTBOX_SELECT = `SELECT id, project_id AS projectId, source, event_type AS eventType,
            subject_type AS subjectType, subject_id AS subjectId,
            delivery_key AS deliveryKey, payload_fingerprint AS payloadFingerprint,
            event_payload_json AS eventPayloadJson, state,
            attempt_count AS attemptCount, max_attempts AS maxAttempts,
            expires_at AS expiresAt,
            credential_limit_window_type AS credentialLimitWindowType,
            credential_limit_observed_at AS credentialLimitObservedAt,
            claim_token AS claimToken,
            admitted_event_id AS admittedEventId, admission_outcome AS admissionOutcome,
            last_error AS lastError,
            terminalized_at AS terminalizedAt
       FROM project_event_source_outbox`;

export async function loadProjectEventSourceIntentByDelivery(
  env: Env,
  input: Pick<AdmitProjectEventInput, 'projectId' | 'source' | 'deliveryKey'>
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `${SOURCE_OUTBOX_SELECT}
      WHERE project_id = ? AND source = ? AND delivery_key = ?
      LIMIT 1`
  )
    .bind(input.projectId, input.source, input.deliveryKey)
    .first<ProjectEventSourceOutboxIntent>();
}

export async function loadProjectEventSourceIntentById(
  env: Env,
  id: string
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `${SOURCE_OUTBOX_SELECT}
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<ProjectEventSourceOutboxIntent>();
}

export async function loadProjectEventSourceIntentByIdentity(
  env: Env,
  input: Pick<ProjectEventSourceOutboxSupersedeInput, 'id' | 'projectId' | 'source' | 'deliveryKey'>
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `${SOURCE_OUTBOX_SELECT}
      WHERE id = ? AND project_id = ? AND source = ? AND delivery_key = ?
      LIMIT 1`
  )
    .bind(input.id, input.projectId, input.source, input.deliveryKey)
    .first<ProjectEventSourceOutboxIntent>();
}

export async function loadProjectEventSourceIntentByClaim(
  env: Env,
  id: string,
  claimToken: string
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `${SOURCE_OUTBOX_SELECT}
      WHERE id = ? AND state = 'processing' AND claim_token = ?
      LIMIT 1`
  )
    .bind(id, claimToken)
    .first<ProjectEventSourceOutboxIntent>();
}
