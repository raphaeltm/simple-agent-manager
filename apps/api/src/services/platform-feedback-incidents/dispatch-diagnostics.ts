/**
 * Why pending incidents are not being dispatched.
 *
 * The incident sweep (`scheduled/incident-triggers.ts`) used to stop at "no dispatchable
 * incidents" without saying why, so a predicate that excluded every incident looked exactly like
 * an empty queue for two months (idea 01M2CKJMNNE0FGASV18J0GFRAT). Every pending row now gets
 * exactly one reason, in the same order the dispatch predicates apply their filters
 * (`listDispatchableIncidentQueue`, `reserveIncidentDispatch`), so the breakdown names the filter
 * that is actually holding each row back.
 */
import type { Env } from '../../env';
import type { IncidentConfig } from '../platform-feedback-incident-config';
import {
  dispatchSeverityRank,
  INCIDENT_SEVERITY_RANK_SQL,
  OPEN_TRACKED_WORK_SQL,
  staleSingletonBefore,
} from './selection';

export const INCIDENT_DISPATCH_BLOCK_REASONS = [
  'rejected',
  'dispatch_attempts_exhausted',
  'budget_deferred',
  'stale_singleton',
  'below_min_severity',
  'tracked_work',
  'dispatchable',
] as const;
export type IncidentDispatchBlockReason = (typeof INCIDENT_DISPATCH_BLOCK_REASONS)[number];

/**
 * A `CASE` naming the first dispatch filter a pending row fails, or `dispatchable`. The binds
 * are returned in placeholder order.
 */
export function incidentDispatchBlockReasonSql(
  config: Pick<
    IncidentConfig,
    'maxDispatchAttempts' | 'staleSingletonMaxAgeMs' | 'minDispatchSeverity'
  >,
  now: number
): { sql: string; binds: unknown[] } {
  return {
    sql: `CASE
      WHEN rejected_at IS NOT NULL THEN 'rejected'
      WHEN dispatch_attempts >= ? THEN 'dispatch_attempts_exhausted'
      WHEN budget_deferred_until IS NOT NULL AND budget_deferred_until > ? THEN 'budget_deferred'
      WHEN occurrence_count = 1 AND last_seen_at < ? THEN 'stale_singleton'
      WHEN ${INCIDENT_SEVERITY_RANK_SQL} < ? THEN 'below_min_severity'
      WHEN ${OPEN_TRACKED_WORK_SQL} THEN 'tracked_work'
      ELSE 'dispatchable'
    END`,
    binds: [
      config.maxDispatchAttempts,
      now,
      staleSingletonBefore(now, config),
      dispatchSeverityRank(config.minDispatchSeverity),
    ],
  };
}

export interface IncidentDispatchBreakdown {
  pending: number;
  /** Pending incidents never dispatched whose queue time is older than the stall window. */
  stalled: number;
  /** `stalled`, split by the filter holding each one back. */
  stalledByReason: Record<IncidentDispatchBlockReason, number>;
  reasons: Record<IncidentDispatchBlockReason, number>;
}

/** One aggregate read over the pending queue. */
export async function explainUndispatchableIncidents(
  env: Env,
  config: IncidentConfig,
  now: number,
  stallWindowMs: number
): Promise<IncidentDispatchBreakdown> {
  const reason = incidentDispatchBlockReasonSql(config, now);
  const rows = await env.DATABASE.prepare(
    `SELECT ${reason.sql} AS reason, COUNT(*) AS count,
       SUM(CASE WHEN dispatch_attempts = 0 AND COALESCE(queued_at, first_seen_at) < ? THEN 1 ELSE 0 END) AS stalled
     FROM platform_feedback_triages
     WHERE queue_state = 'pending'
     GROUP BY reason`
  )
    .bind(...reason.binds, now - stallWindowMs)
    .all<{ reason: string; count: number; stalled: number | null }>();
  const zero = () =>
    Object.fromEntries(INCIDENT_DISPATCH_BLOCK_REASONS.map((key) => [key, 0])) as Record<
      IncidentDispatchBlockReason,
      number
    >;
  const reasons = zero();
  const stalledByReason = zero();
  let pending = 0;
  let stalled = 0;
  for (const row of rows.results ?? []) {
    const count = Number(row.count) || 0;
    pending += count;
    stalled += Number(row.stalled) || 0;
    if ((INCIDENT_DISPATCH_BLOCK_REASONS as readonly string[]).includes(row.reason)) {
      reasons[row.reason as IncidentDispatchBlockReason] += count;
      stalledByReason[row.reason as IncidentDispatchBlockReason] += Number(row.stalled) || 0;
    }
  }
  return { pending, stalled, stalledByReason, reasons };
}
