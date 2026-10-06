import type { Env } from '../../env';
import type { IncidentRow } from './types';

export async function readIncidentRow(env: Env, signature: string): Promise<IncidentRow | null> {
  return (
    (await env.DATABASE.prepare(
      `SELECT triage.signature, triage.source, triage.summary, triage.severity,
        triage.first_seen_at, triage.last_seen_at, triage.occurrence_count,
        triage.evidence_refs, triage.diagnosis_id, triage.idea_id, triage.failure_count,
        triage.last_failure_reason, triage.last_failed_at, triage.rejected_at,
        triage.queue_state, triage.queued_at, triage.dispatch_lease_token,
        triage.dispatch_lease_expires_at, triage.dispatched_trigger_id,
        triage.dispatched_execution_id, triage.dispatched_task_id, triage.dispatched_at,
        triage.dispatch_attempts, triage.incident_claim_token, triage.incident_claim_expires_at,
        triage.incident_claimed_by_task_id, triage.incident_claimed_at, triage.resolved_at,
        triage.resolved_by_task_id, resolved_task.output_pr_url AS resolved_task_output_pr_url,
        triage.resolution_note, triage.resolution_references, triage.expired_at,
        triage.created_at, triage.updated_at
       FROM platform_feedback_triages triage
       LEFT JOIN tasks resolved_task ON resolved_task.id = triage.resolved_by_task_id
       WHERE triage.signature = ?`
    )
      .bind(signature)
      .first<IncidentRow>()) ?? null
  );
}
