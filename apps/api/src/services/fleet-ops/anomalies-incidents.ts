/**
 * Private incident queue classes for `ops_find_anomalies` (`./anomalies.ts`).
 */
import { neutralizeUntrustedText } from '@simple-agent-manager/operations';

import {
  getIncidentConfig,
  incidentDispatchBlockReasonSql,
} from '../platform-feedback-incidents';
import { type AnomalyClassResult, int, result, type SweepContext, text } from './anomaly-shared';

const HOUR_MS = 60 * 60 * 1000;

export async function pendingIncidents(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT signature, source, severity, occurrence_count, last_seen_at,
            COUNT(*) OVER () AS total
     FROM platform_feedback_triages
     WHERE queue_state = 'pending'
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
       last_seen_at DESC, signature ASC
     LIMIT ?`
  )
    .bind(ctx.cap)
    .all<Record<string, unknown>>();
  return result('pending_incident', rows.results ?? [], (row) => {
    const lastSeen = int(row.last_seen_at);
    return {
      // Signatures derive from reported error text; strip control characters and markers.
      ids: { signature: neutralizeUntrustedText(text(row.signature) ?? '') || null },
      reason:
        `Pending ${text(row.severity) ?? 'unknown'} incident from ${text(row.source) ?? 'unknown'} ` +
        `seen ${int(row.occurrence_count)} time(s) (read with get_incident).`,
      observedAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    };
  });
}

/**
 * A pending incident that has waited past the stall window without a single dispatch. The
 * incident triage queue went silent for two months because every incident was excluded by its
 * own idea, and nothing reported it (idea 01M2CKJMNNE0FGASV18J0GFRAT). The reason names the
 * dispatch filter holding the row back, from the same classifier the incident sweep logs.
 */
export async function incidentDispatchStalled(ctx: SweepContext): Promise<AnomalyClassResult> {
  const blockReason = incidentDispatchBlockReasonSql(getIncidentConfig(ctx.env), ctx.now);
  const stallBefore = ctx.now - ctx.settings.incidentDispatchStallHours * HOUR_MS;
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT signature, source, severity, occurrence_count,
            COALESCE(queued_at, first_seen_at) AS waiting_since,
            ${blockReason.sql} AS block_reason,
            COUNT(*) OVER () AS total
     FROM platform_feedback_triages
     WHERE queue_state = 'pending'
       AND dispatch_attempts = 0
       AND COALESCE(queued_at, first_seen_at) < ?
     ORDER BY COALESCE(queued_at, first_seen_at) ASC, signature ASC
     LIMIT ?`
  )
    .bind(...blockReason.binds, stallBefore, ctx.cap)
    .all<Record<string, unknown>>();
  return result('incident_dispatch_stalled', rows.results ?? [], (row) => {
    const waitingSince = int(row.waiting_since);
    const hours = waitingSince ? Math.round((ctx.now - waitingSince) / HOUR_MS) : null;
    return {
      ids: { signature: neutralizeUntrustedText(text(row.signature) ?? '') || null },
      reason:
        `Pending ${text(row.severity) ?? 'unknown'} incident from ${text(row.source) ?? 'unknown'} ` +
        `has waited ${hours ?? '?'} h without being dispatched to incident triage ` +
        `(held back by: ${text(row.block_reason) ?? 'unknown'}; the incident sweep logs ` +
        `incident_trigger_sweep.declined with the full breakdown).`,
      observedAt: waitingSince ? new Date(waitingSince).toISOString() : null,
    };
  });
}
