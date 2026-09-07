import type { AdmitProjectEventInput } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type {
  ProjectEventSourceOutboxIntent,
  ProjectEventSourceOutboxReadByIdInput,
} from './project-event-source-outbox-contract';

// Internal storage helpers for project-event-source-outbox.ts. Cross-source callers
// should use the scoped service exports in project-event-source-outbox.ts.
const INTENT_SELECT_COLUMNS = `id, project_id AS projectId, source, event_type AS eventType,
       subject_type AS subjectType, subject_id AS subjectId,
       delivery_key AS deliveryKey, payload_fingerprint AS payloadFingerprint,
       event_payload_json AS eventPayloadJson, state,
       attempt_count AS attemptCount, max_attempts AS maxAttempts,
       expires_at AS expiresAt, claim_token AS claimToken,
       admitted_event_id AS admittedEventId, admission_outcome AS admissionOutcome,
       last_error AS lastError, terminalized_at AS terminalizedAt,
       credential_limit_window_type AS credentialLimitWindowType,
       credential_limit_observed_at AS credentialLimitObservedAt`;

async function loadProjectEventSourceIntentWhere(
  env: Env,
  where: string,
  values: readonly unknown[]
): Promise<ProjectEventSourceOutboxIntent | null> {
  return env.DATABASE.prepare(
    `SELECT ${INTENT_SELECT_COLUMNS}
       FROM project_event_source_outbox
      WHERE ${where}
      LIMIT 1`
  )
    .bind(...values)
    .first<ProjectEventSourceOutboxIntent>();
}

export async function loadProjectEventSourceIntentByDelivery(
  env: Env,
  input: Pick<AdmitProjectEventInput, 'projectId' | 'source' | 'deliveryKey'>
): Promise<ProjectEventSourceOutboxIntent | null> {
  return loadProjectEventSourceIntentWhere(
    env,
    'project_id = ? AND source = ? AND delivery_key = ?',
    [input.projectId, input.source, input.deliveryKey]
  );
}

export async function loadProjectEventSourceIntentByInternalId(
  env: Env,
  id: string
): Promise<ProjectEventSourceOutboxIntent | null> {
  return loadProjectEventSourceIntentWhere(env, 'id = ?', [id]);
}

export async function loadProjectEventSourceIntentByIdentity(
  env: Env,
  input: ProjectEventSourceOutboxReadByIdInput
): Promise<ProjectEventSourceOutboxIntent | null> {
  return loadProjectEventSourceIntentWhere(
    env,
    'id = ? AND project_id = ? AND source = ? AND delivery_key = ?',
    [input.id, input.projectId, input.source, input.deliveryKey]
  );
}

export async function loadProjectEventSourceIntentByClaim(
  env: Env,
  id: string,
  claimToken: string
): Promise<ProjectEventSourceOutboxIntent | null> {
  return loadProjectEventSourceIntentWhere(
    env,
    "id = ? AND state = 'processing' AND claim_token = ?",
    [id, claimToken]
  );
}
