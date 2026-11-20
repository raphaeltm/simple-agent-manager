/**
 * The WATCHING disposition of a private incident (`queue_state = 'watching'`).
 *
 * Triage sets it (`watchIncident`) on a genuine defect that is not urgent. While watching, the
 * hourly triage runner (`platform-feedback-triage/runner.ts`) records each recurrence here
 * instead of reopening the incident: exact new occurrences go into hourly buckets, and the
 * signature's single idea is refreshed with the counts. Nothing is diagnosed or dispatched.
 *
 * Two exits keep the state bounded (rule 47):
 * - a spike (enough occurrences since the watch decision, well above the earlier rate) returns
 *   the incident to `pending` with a reason, so triage looks at it again as a possible fix-now;
 * - a quiet period with no occurrence expires it, and the hourly idea reconciliation closes its
 *   idea (`closeEndedIncidentIdeas`). A recurrence after that reopens it like any expired row.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { resolveFleetOpsSettings } from '../fleet-ops/settings';
import { FLEET_OPS_DEFAULTS, type FleetOpsSettings } from '../fleet-ops/settings-definitions';
import { sanitizeText } from './text';

const HOUR_MS = 60 * 60 * 1000;

export interface WatchConfig {
  recentWindowMs: number;
  spikeWindowMs: number;
  spikeMinOccurrences: number;
  spikeBaselineMultiplier: number;
  quietExpiryMs: number;
}

type WatchSettings = Pick<
  FleetOpsSettings,
  | 'incidentWatchRecentWindowHours'
  | 'incidentWatchSpikeWindowHours'
  | 'incidentWatchSpikeMinOccurrences'
  | 'incidentWatchSpikeBaselineMultiplier'
  | 'incidentWatchQuietExpiryHours'
>;

export function watchConfigFromSettings(settings: WatchSettings): WatchConfig {
  const recentWindowMs = settings.incidentWatchRecentWindowHours * HOUR_MS;
  return {
    recentWindowMs,
    spikeWindowMs: Math.min(settings.incidentWatchSpikeWindowHours * HOUR_MS, recentWindowMs),
    spikeMinOccurrences: settings.incidentWatchSpikeMinOccurrences,
    spikeBaselineMultiplier: settings.incidentWatchSpikeBaselineMultiplier,
    quietExpiryMs: settings.incidentWatchQuietExpiryHours * HOUR_MS,
  };
}

/**
 * Watch settings from the admin registry, falling back to the code defaults when settings are
 * unreadable: counting a recurrence or listing the queue must not fail on a settings outage.
 */
export async function loadWatchConfig(env: Env): Promise<WatchConfig> {
  try {
    return watchConfigFromSettings(await resolveFleetOpsSettings(env));
  } catch (error) {
    log.warn('platform_feedback_incident.watch_settings_read_failed', {
      error: error instanceof Error ? error.message : String(error),
      action: 'using_defaults',
    });
    return watchConfigFromSettings(FLEET_OPS_DEFAULTS);
  }
}

/** Epoch hour -> occurrences. Malformed storage reads as empty rather than failing the row. */
export function parseHourlyCounts(raw: string | null | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  if (!raw) return counts;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return counts;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return counts;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const hour = Number(key);
    if (!Number.isSafeInteger(hour) || typeof value !== 'number') continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    counts.set(hour, Math.round(value));
  }
  return counts;
}

function serializeHourlyCounts(counts: Map<number, number>): string {
  const sorted = [...counts.entries()].sort(([left], [right]) => left - right);
  return JSON.stringify(Object.fromEntries(sorted.map(([hour, n]) => [String(hour), n])));
}

/** Occurrences in buckets whose hour starts at or after `since`. */
function countSince(counts: Map<number, number>, since: number, before = Infinity): number {
  let total = 0;
  for (const [hour, n] of counts) {
    const start = hour * HOUR_MS;
    if (start >= since && start < before) total += n;
  }
  return total;
}

/**
 * Occurrences recorded while watching in the recent window. The bucket of the hour that
 * contains the window start is included, so the measure covers at least the full window.
 */
export function recentOccurrenceCount(
  raw: string | null | undefined,
  now: number,
  recentWindowMs: number
): number {
  return countSince(parseHourlyCounts(raw), Math.floor((now - recentWindowMs) / HOUR_MS) * HOUR_MS);
}

export interface SpikeVerdict {
  spike: boolean;
  spikeCount: number;
  baselinePerWindow: number;
  reason: string | null;
}

/**
 * A spike counts only occurrences after the latest watch decision, so a burst triage already
 * looked at (and chose to keep watching) cannot re-queue it. Buckets are hourly: those starting
 * before `watchingSince` are excluded, which can under-count by less than an hour.
 *
 * The baseline is the average per spike window over the rest of the recent window, measured
 * only over the hours actually covered by buckets, so a young watch is not compared with
 * empty days.
 */
export function evaluateSpike(
  counts: Map<number, number>,
  now: number,
  watchingSince: number | null,
  config: WatchConfig
): SpikeVerdict {
  const spikeStart = Math.max(now - config.spikeWindowMs, watchingSince ?? 0);
  const spikeCount = countSince(counts, spikeStart);
  const baselineEnd = now - config.spikeWindowMs;
  const earliestBucket = Math.min(...[...counts.keys()].map((hour) => hour * HOUR_MS), Infinity);
  const baselineStart = Math.max(now - config.recentWindowMs, earliestBucket);
  const coveredMs = baselineEnd - baselineStart;
  const baselinePerWindow =
    coveredMs > 0
      ? (countSince(counts, baselineStart, baselineEnd) * config.spikeWindowMs) / coveredMs
      : 0;
  const spike =
    spikeCount >= config.spikeMinOccurrences &&
    spikeCount >= config.spikeBaselineMultiplier * baselinePerWindow;
  const hours = Math.round(config.spikeWindowMs / HOUR_MS);
  return {
    spike,
    spikeCount,
    baselinePerWindow,
    reason: spike
      ? `spike: ${spikeCount} occurrences in the last ${hours}h while watching ` +
        `(threshold ${config.spikeMinOccurrences}, earlier rate ${baselinePerWindow.toFixed(1)} per ${hours}h)`
      : null,
  };
}

export interface WatchedRecurrenceInput {
  signature: string;
  /** Timestamps of every error in this grouping window (bounded by the triage error limit). */
  occurrenceTimestamps: readonly number[];
  severity: string;
  evidenceRefs: string;
  now: number;
  config: WatchConfig;
}

export interface WatchedRecurrenceOutcome {
  /** False when the row is no longer watching or lost the compare-and-set. */
  recorded: boolean;
  newOccurrences: number;
  escalated: boolean;
  escalationReason: string | null;
}

interface WatchedRow {
  queue_state: string;
  last_seen_at: number;
  watching_since: number | null;
  watch_hourly_counts: string | null;
}

/**
 * Records one grouping window's recurrence of a watched incident. Only errors newer than the
 * stored `last_seen_at` count, because the hourly windows overlap; the write is a
 * compare-and-set on that value, so two runs over the same window cannot both add it.
 */
export async function recordWatchedRecurrence(
  env: Env,
  input: WatchedRecurrenceInput
): Promise<WatchedRecurrenceOutcome> {
  const none = { recorded: false, newOccurrences: 0, escalated: false, escalationReason: null };
  const row = await env.DATABASE.prepare(
    `SELECT queue_state, last_seen_at, watching_since, watch_hourly_counts
     FROM platform_feedback_triages WHERE signature = ?`
  )
    .bind(input.signature)
    .first<WatchedRow>();
  if (!row || row.queue_state !== 'watching') return none;
  const fresh = input.occurrenceTimestamps.filter(
    (timestamp) => Number.isFinite(timestamp) && timestamp > row.last_seen_at
  );
  if (fresh.length === 0) return { ...none, recorded: true };

  const counts = parseHourlyCounts(row.watch_hourly_counts);
  for (const timestamp of fresh) {
    const hour = Math.floor(timestamp / HOUR_MS);
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  const oldestKept = Math.floor((input.now - input.config.recentWindowMs) / HOUR_MS);
  for (const hour of [...counts.keys()]) if (hour < oldestKept) counts.delete(hour);

  const verdict = evaluateSpike(counts, input.now, row.watching_since, input.config);
  const lastSeenAt = Math.max(...fresh);
  const firstSeenAt = Math.min(...fresh);
  const escalate = verdict.spike ? 1 : 0;
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET
       occurrence_count = occurrence_count + ?,
       first_seen_at = MIN(first_seen_at, ?),
       last_seen_at = MAX(last_seen_at, ?),
       evidence_refs = ?,
       severity = CASE WHEN ? = 'error' THEN 'error' ELSE severity END,
       watch_hourly_counts = ?,
       queue_state = CASE WHEN ? THEN 'pending' ELSE queue_state END,
       queued_at = CASE WHEN ? THEN ? ELSE queued_at END,
       watch_escalated_at = CASE WHEN ? THEN ? ELSE watch_escalated_at END,
       watch_escalation_reason = CASE WHEN ? THEN ? ELSE watch_escalation_reason END,
       updated_at = CURRENT_TIMESTAMP
     WHERE signature = ? AND queue_state = 'watching' AND last_seen_at = ?`
  )
    .bind(
      fresh.length,
      firstSeenAt,
      lastSeenAt,
      input.evidenceRefs,
      input.severity,
      serializeHourlyCounts(counts),
      escalate,
      escalate,
      input.now,
      escalate,
      input.now,
      escalate,
      verdict.reason,
      input.signature,
      row.last_seen_at
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) return none;
  if (verdict.spike) {
    log.warn('platform_feedback_incident.watch_spike_requeued', {
      signature: input.signature.slice(0, 16),
      spikeCount: verdict.spikeCount,
      baselinePerWindow: verdict.baselinePerWindow,
      action: 'requeued',
    });
  }
  return {
    recorded: true,
    newOccurrences: fresh.length,
    escalated: verdict.spike,
    escalationReason: verdict.reason,
  };
}

/**
 * Moves a claimed incident to watching. The claim fence is the same as `resolveIncident`'s.
 * Dispatch attempts reset because the triage episode succeeded (rule 61). Hourly counts are
 * kept, so a re-watch after a spike keeps its history and its earlier rate.
 */
export async function watchIncident(
  env: Env,
  signature: string,
  claimToken: string,
  taskId: string,
  reason: string,
  now: number,
  reasonMaxLength: number
): Promise<boolean> {
  const sanitizedReason = sanitizeText(reason, reasonMaxLength);
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'watching',
       watching_since = ?, watch_reason = ?, resolution_note = ?,
       watch_hourly_counts = COALESCE(watch_hourly_counts, '{}'),
       dispatch_attempts = 0, budget_deferred_until = NULL, budget_deferred_reason = NULL,
       incident_claim_token = NULL, incident_claim_expires_at = NULL,
       incident_claimed_by_task_id = NULL, incident_claimed_at = NULL,
       dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
       dispatched_trigger_id = NULL, dispatched_execution_id = NULL, dispatched_task_id = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE signature = ?
       AND queue_state = 'claimed'
       AND rejected_at IS NULL
       AND incident_claim_token = ?
       AND incident_claimed_by_task_id = ?
       AND incident_claim_expires_at >= ?`
  )
    .bind(now, sanitizedReason, sanitizedReason, signature, claimToken, taskId, now)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Expires watched incidents with no occurrence for the quiet period. Runs after the hourly
 * runner has recorded this window's recurrences, so a signature that is still recurring has a
 * fresh `last_seen_at` and stays watched. One statement on the indexed state column.
 */
export async function expireQuietWatchedIncidents(
  env: Env,
  now: number,
  config: Pick<WatchConfig, 'quietExpiryMs'>
): Promise<number> {
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'expired', expired_at = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE queue_state = 'watching' AND last_seen_at < ?`
  )
    .bind(now, now - config.quietExpiryMs)
    .run();
  return result.meta.changes ?? 0;
}
