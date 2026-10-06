import type { Env } from '../../env';
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { ulid } from '../../lib/ulid';
import { getIncidentConfig, type IncidentConfig } from '../platform-feedback-incident-config';
import { TERMINAL_TASK_STATUS_SQL } from './constants';
import {
  dispatchSeverityRank,
  INCIDENT_SEVERITY_RANK_SQL,
  OPEN_TRACKED_WORK_SQL,
  staleSingletonBefore,
} from './selection';
import { placeholders } from './state';

const RESERVE_INCIDENT_DISPATCH_FIXED_BINDINGS = 9;
const RESERVE_INCIDENT_DISPATCH_SIGNATURE_CHUNK_SIZE =
  D1_MAX_BOUND_PARAMETERS - RESERVE_INCIDENT_DISPATCH_FIXED_BINDINGS;

export async function reclaimExpiredIncidentDispatches(
  env: Env,
  now: number = Date.now(),
  config: IncidentConfig = getIncidentConfig(env)
): Promise<{ requeued: number; rejected: number }> {
  // A dispatch lease expiring only proves the handoff marker is old. It does not
  // prove the dispatched task is dead. Mirror the task row that
  // completeIncidentDispatchLink() writes and preserve the lease while that task
  // remains non-terminal; trigger cleanup/admission use the same liveness owner.
  const liveDispatchedTaskPredicateFor = (tableRef: string) => `NOT EXISTS (
    SELECT 1 FROM tasks live_task
     WHERE live_task.status NOT IN (${TERMINAL_TASK_STATUS_SQL})
       AND (
         live_task.id = ${tableRef}.dispatched_task_id
         OR live_task.id = (
           SELECT e.task_id FROM trigger_executions e
            WHERE e.id = ${tableRef}.dispatched_execution_id
            LIMIT 1
         )
       )
  )`;
  const liveDispatchedTaskPredicate = liveDispatchedTaskPredicateFor('triage');
  const liveDispatchedTaskUpdatePredicate = liveDispatchedTaskPredicateFor(
    'platform_feedback_triages'
  );
  const expired = await env.DATABASE.prepare(
    `SELECT triage.signature, triage.dispatch_attempts,
       EXISTS (
         SELECT 1 FROM task_status_events event
         WHERE event.task_id = triage.dispatched_task_id
           AND event.to_status = 'failed'
           AND event.actor_type = 'workspace_callback'
       ) AS agent_reported_failure
     FROM platform_feedback_triages triage
     WHERE triage.queue_state = 'dispatched'
       AND triage.dispatch_lease_expires_at IS NOT NULL
       AND triage.dispatch_lease_expires_at < ?
       AND ${liveDispatchedTaskPredicate}
     ORDER BY triage.dispatch_lease_expires_at ASC, triage.signature ASC
     LIMIT ?`
  )
    .bind(now, config.reclaimLimit)
    .all<{
      signature: string;
      dispatch_attempts: number;
      agent_reported_failure: number;
    }>();

  let requeued = 0;
  let rejected = 0;
  for (const row of expired.results ?? []) {
    const consumedAttempt = row.agent_reported_failure ? 1 : 0;
    const nextAttempts = row.dispatch_attempts + consumedAttempt;
    if (nextAttempts >= config.maxDispatchAttempts) {
      const reject = await env.DATABASE.prepare(
        `UPDATE platform_feedback_triages SET queue_state = 'rejected',
          rejected_at = COALESCE(rejected_at, ?),
          resolution_note = ?,
          dispatch_attempts = ?,
          dispatch_lease_token = NULL,
          dispatch_lease_expires_at = NULL,
          dispatched_trigger_id = NULL,
          dispatched_execution_id = NULL,
          dispatched_task_id = NULL,
          updated_at = CURRENT_TIMESTAMP
         WHERE signature = ?
           AND queue_state = 'dispatched'
           AND dispatch_lease_expires_at IS NOT NULL
           AND dispatch_lease_expires_at < ?
           AND ${liveDispatchedTaskUpdatePredicate}`
      )
        .bind(
          now,
          'incident dispatch attempts exhausted after lease expiry',
          nextAttempts,
          row.signature,
          now
        )
        .run();
      rejected += reject.meta.changes ?? 0;
      continue;
    }

    const requeue = await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET queue_state = 'pending',
        dispatch_lease_token = NULL,
        dispatch_lease_expires_at = NULL,
        dispatched_trigger_id = NULL,
        dispatched_execution_id = NULL,
        dispatched_task_id = NULL,
        dispatch_attempts = ?,
        queued_at = COALESCE(queued_at, ?),
        updated_at = CURRENT_TIMESTAMP
       WHERE signature = ?
         AND queue_state = 'dispatched'
         AND dispatch_lease_expires_at IS NOT NULL
         AND dispatch_lease_expires_at < ?
         AND ${liveDispatchedTaskUpdatePredicate}`
    )
      .bind(nextAttempts, now, row.signature, now)
      .run();
    requeued += requeue.meta.changes ?? 0;
  }

  return { requeued, rejected };
}

export async function reserveIncidentDispatch(
  env: Env,
  signatures: string[],
  triggerId: string,
  executionId: string,
  now: number = Date.now(),
  config: IncidentConfig = getIncidentConfig(env)
): Promise<{ leaseToken: string; reserved: number }> {
  if (signatures.length === 0) return { leaseToken: '', reserved: 0 };
  const leaseToken = ulid();
  const staleSingletonCutoff = staleSingletonBefore(now, config);
  let reserved = 0;
  for (
    let offset = 0;
    offset < signatures.length;
    offset += RESERVE_INCIDENT_DISPATCH_SIGNATURE_CHUNK_SIZE
  ) {
    const chunk = signatures.slice(offset, offset + RESERVE_INCIDENT_DISPATCH_SIGNATURE_CHUNK_SIZE);
    const result = await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET queue_state = 'dispatched',
        dispatch_lease_token = ?, dispatch_lease_expires_at = ?,
        dispatched_trigger_id = ?, dispatched_execution_id = ?, dispatched_at = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE signature IN (${placeholders(chunk)})
         AND queue_state = 'pending'
         AND rejected_at IS NULL
         AND dispatch_attempts < ?
         AND (budget_deferred_until IS NULL OR budget_deferred_until <= ?)
         AND NOT (occurrence_count = 1 AND last_seen_at < ?)
         AND ${INCIDENT_SEVERITY_RANK_SQL} >= ?
         AND NOT ${OPEN_TRACKED_WORK_SQL}`
    )
      .bind(
        leaseToken,
        now + config.dispatchLeaseTtlMs,
        triggerId,
        executionId,
        now,
        ...chunk,
        config.maxDispatchAttempts,
        now,
        staleSingletonCutoff,
        dispatchSeverityRank(config.minDispatchSeverity)
      )
      .run();
    reserved += result.meta.changes ?? 0;
  }
  return { leaseToken, reserved };
}

export async function completeIncidentDispatchLink(
  env: Env,
  executionId: string,
  taskId: string
): Promise<number> {
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET dispatched_task_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE dispatched_execution_id = ? AND queue_state = 'dispatched'`
  )
    .bind(taskId, executionId)
    .run();
  return result.meta.changes ?? 0;
}

export async function releaseIncidentDispatch(env: Env, executionId: string): Promise<number> {
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'pending',
      dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
      dispatched_trigger_id = NULL, dispatched_execution_id = NULL, dispatched_task_id = NULL,
      updated_at = CURRENT_TIMESTAMP
     WHERE dispatched_execution_id = ? AND queue_state = 'dispatched'`
  )
    .bind(executionId)
    .run();
  return result.meta.changes ?? 0;
}
