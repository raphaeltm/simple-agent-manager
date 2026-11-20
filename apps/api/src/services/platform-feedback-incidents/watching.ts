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
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { log } from '../../lib/logger';
import { resolveFleetOpsSettings } from '../fleet-ops/settings';
import { FLEET_OPS_DEFAULTS, type FleetOpsSettings } from '../fleet-ops/settings-definitions';
import { IncidentResolutionValidationError } from '../platform-feedback-incident-resolution-references';
import { REPORT_SOURCE } from './constants';
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

/**
 * Epoch hour -> occurrences. Malformed storage reads as empty rather than failing the row.
 * The SQL ranking (`RECENT_WATCH_OCCURRENCES_SQL`, queries.ts) applies the same rules (integer
 * key in canonical form, positive integer value), so a list ranks by the count it returns.
 */
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
    if (!Number.isSafeInteger(hour) || String(hour) !== key) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) continue;
    counts.set(hour, value);
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

/** Occurrences in [start, end), counting a bucket in proportion to its hour's overlap. */
function countOverlap(counts: Map<number, number>, start: number, end: number): number {
  let total = 0;
  for (const [hour, n] of counts) {
    const bucketStart = hour * HOUR_MS;
    const overlap = Math.min(end, bucketStart + HOUR_MS) - Math.max(start, bucketStart);
    if (overlap > 0) total += (n * overlap) / HOUR_MS;
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
 * looked at (and chose to keep watching) cannot re-queue it. When the decision is inside the
 * spike window, the count starts at the decision's hour bucket minus `watchSpikeOffset` (what
 * that bucket already held when the decision was made, `watchIncident`), so a burst right after
 * the decision counts in full. Otherwise the window boundary falls inside an hourly bucket,
 * which counts in proportion to the part of its hour inside the window (an estimate: buckets
 * do not record minutes).
 *
 * The baseline is the average per spike window over the rest of the recent window, with the
 * same proportional boundary. It covers the hours since watching began (or since the earliest
 * recorded bucket, when a re-watch kept older history), so a young watch is not compared with
 * days it was not watched, and an empty hour while watched counts as a zero-rate hour.
 */
export function evaluateSpike(
  counts: Map<number, number>,
  now: number,
  watchingSince: number | null,
  config: WatchConfig,
  watchSpikeOffset = 0
): SpikeVerdict {
  const windowStart = now - config.spikeWindowMs;
  // Decision inside the window: count from its hour, minus what that hour already held (exact).
  // Otherwise the window starts mid-bucket, and the boundary bucket counts in proportion to the
  // part of its hour inside the window: hourly buckets cannot place occurrences more finely.
  const spikeCount =
    watchingSince !== null && watchingSince >= windowStart
      ? Math.max(
          0,
          countSince(counts, Math.floor(watchingSince / HOUR_MS) * HOUR_MS) -
            Math.max(0, watchSpikeOffset)
        )
      : countOverlap(counts, windowStart, Infinity);
  const baselineEnd = windowStart;
  const earliestBucket = Math.min(...[...counts.keys()].map((hour) => hour * HOUR_MS), Infinity);
  const observedSince = Math.min(earliestBucket, watchingSince ?? Infinity);
  const baselineStart = Math.max(now - config.recentWindowMs, observedSince);
  const coveredMs = baselineEnd - baselineStart;
  const baselinePerWindow =
    coveredMs > 0
      ? (countOverlap(counts, baselineStart, baselineEnd) * config.spikeWindowMs) / coveredMs
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
      ? `spike: ${Math.round(spikeCount)} occurrences in the last ${hours}h while watching ` +
        `(threshold ${config.spikeMinOccurrences}, earlier rate ${baselinePerWindow.toFixed(1)} per ${hours}h)`
      : null,
  };
}

export interface WatchedRecurrenceInput {
  signature: string;
  /** Id and timestamp of every error in this grouping window. */
  occurrences: readonly { id: string; timestamp: number }[];
  severity: string;
  evidenceRefs: string;
  now: number;
  config: WatchConfig;
  /** How long counted ids are remembered: at least two triage windows. */
  dedupeHorizonMs: number;
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
  watch_count_floor: number | null;
  watch_counted_ids: string | null;
  watch_spike_offset: number | null;
}

/** Counted error id -> timestamp. Malformed storage reads as empty. */
function parseCountedIds(raw: string | null | undefined): Map<string, number> {
  const ids = new Map<string, number>();
  if (!raw) return ids;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ids;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ids;
  for (const [id, timestamp] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) ids.set(id, timestamp);
  }
  return ids;
}

/** Longest error id kept for deduplication; platform error ids are ULIDs or UUIDs. */
const COUNTED_ID_MAX_LENGTH = 64;

/**
 * Records one grouping window's recurrence of a watched incident. Each platform error id is
 * counted once: ids counted within the dedupe horizon are remembered on the row, so
 * overlapping windows, a manual run, an error that committed late with an older timestamp, or
 * two errors in one millisecond are all counted exactly once. Errors at or before the watch
 * floor (`last_seen_at` when watching began) were already counted by the ordinary path.
 *
 * Not covered: errors the triage fetch never returns (more than the triage error limit in one
 * window). That bound is shared with the whole triage pipeline.
 *
 * The write is a compare-and-set on the stored id set. A run that loses it (another run wrote
 * first) re-reads the ids and merges its own still-unseen occurrences, up to
 * WATCHED_RECORD_MAX_ATTEMPTS times, so two overlapping runs never double-count or drop each
 * other's occurrences.
 */
/** Compare-and-set attempts per recording: a lost race re-reads the ids and merges its own. */
const WATCHED_RECORD_MAX_ATTEMPTS = 3;
const LOST_RACE = Symbol('lost-race');

export async function recordWatchedRecurrence(
  env: Env,
  input: WatchedRecurrenceInput
): Promise<WatchedRecurrenceOutcome> {
  for (let attempt = 1; attempt <= WATCHED_RECORD_MAX_ATTEMPTS; attempt += 1) {
    const outcome = await attemptWatchedRecord(env, input);
    if (outcome !== LOST_RACE) return outcome;
  }
  // Another run kept winning: its write holds most of this window; report this one unrecorded.
  log.warn('platform_feedback_incident.watch_record_lost_race', {
    signature: input.signature.slice(0, 16),
    attempts: WATCHED_RECORD_MAX_ATTEMPTS,
    action: 'skipped',
  });
  return { recorded: false, newOccurrences: 0, escalated: false, escalationReason: null };
}

async function attemptWatchedRecord(
  env: Env,
  input: WatchedRecurrenceInput
): Promise<WatchedRecurrenceOutcome | typeof LOST_RACE> {
  const none = { recorded: false, newOccurrences: 0, escalated: false, escalationReason: null };
  const row = await env.DATABASE.prepare(
    `SELECT queue_state, last_seen_at, watching_since, watch_hourly_counts,
       watch_count_floor, watch_counted_ids, watch_spike_offset
     FROM platform_feedback_triages WHERE signature = ?`
  )
    .bind(input.signature)
    .first<WatchedRow>();
  if (!row || row.queue_state !== 'watching') return none;
  const floor = row.watch_count_floor ?? row.last_seen_at;
  const counted = parseCountedIds(row.watch_counted_ids);
  const fresh: { id: string; timestamp: number }[] = [];
  for (const occurrence of input.occurrences) {
    const id = occurrence.id.slice(0, COUNTED_ID_MAX_LENGTH);
    if (!Number.isFinite(occurrence.timestamp) || occurrence.timestamp <= floor) continue;
    if (counted.has(id)) continue;
    counted.set(id, occurrence.timestamp);
    fresh.push({ id, timestamp: occurrence.timestamp });
  }
  if (fresh.length === 0) return { ...none, recorded: true };
  const horizon = input.now - input.dedupeHorizonMs;
  for (const [id, timestamp] of [...counted]) if (timestamp < horizon) counted.delete(id);

  const counts = parseHourlyCounts(row.watch_hourly_counts);
  for (const { timestamp } of fresh) {
    const hour = Math.floor(timestamp / HOUR_MS);
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  const oldestKept = Math.floor((input.now - input.config.recentWindowMs) / HOUR_MS);
  for (const hour of [...counts.keys()]) if (hour < oldestKept) counts.delete(hour);

  const verdict = evaluateSpike(
    counts,
    input.now,
    row.watching_since,
    input.config,
    row.watch_spike_offset ?? 0
  );
  const timestamps = fresh.map((item) => item.timestamp);
  const escalate = verdict.spike ? 1 : 0;
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET
       occurrence_count = occurrence_count + ?,
       first_seen_at = MIN(first_seen_at, ?),
       last_seen_at = MAX(last_seen_at, ?),
       evidence_refs = ?,
       severity = CASE WHEN ? = 'error' THEN 'error' ELSE severity END,
       watch_hourly_counts = ?,
       watch_counted_ids = ?,
       queue_state = CASE WHEN ? THEN 'pending' ELSE queue_state END,
       queued_at = CASE WHEN ? THEN ? ELSE queued_at END,
       watch_escalated_at = CASE WHEN ? THEN ? ELSE watch_escalated_at END,
       watch_escalation_reason = CASE WHEN ? THEN ? ELSE watch_escalation_reason END,
       updated_at = CURRENT_TIMESTAMP
     WHERE signature = ? AND queue_state = 'watching' AND watch_counted_ids IS ?`
  )
    .bind(
      fresh.length,
      Math.min(...timestamps),
      Math.max(...timestamps),
      input.evidenceRefs,
      input.severity,
      serializeHourlyCounts(counts),
      JSON.stringify(Object.fromEntries(counted)),
      escalate,
      escalate,
      input.now,
      escalate,
      input.now,
      escalate,
      verdict.reason,
      input.signature,
      row.watch_counted_ids
    )
    .run();
  // Another run recorded this row first: re-read its counted ids and merge ours.
  if ((result.meta.changes ?? 0) !== 1) return LOST_RACE;
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
 * A person's report (`source = 'user-report'`) cannot be watched: its recurrences arrive
 * through `upsertUserReportIncident`, which does not record watched occurrences, and a report
 * deserves a fix or an explicit rejection.
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
  if (!sanitizedReason) {
    throw new IncidentResolutionValidationError(
      'Watching requires a one-line reason in note: why this defect is real but not urgent.'
    );
  }
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'watching',
       watching_since = ?, watch_reason = ?, resolution_note = ?,
       watch_hourly_counts = COALESCE(watch_hourly_counts, '{}'),
       watch_count_floor = last_seen_at, watch_counted_ids = '{}',
       watch_spike_offset = CASE WHEN json_valid(watch_hourly_counts)
         THEN COALESCE(json_extract(watch_hourly_counts, ?), 0) ELSE 0 END,
       dispatch_attempts = 0, budget_deferred_until = NULL, budget_deferred_reason = NULL,
       incident_claim_token = NULL, incident_claim_expires_at = NULL,
       incident_claimed_by_task_id = NULL, incident_claimed_at = NULL,
       dispatch_lease_token = NULL, dispatch_lease_expires_at = NULL,
       dispatched_trigger_id = NULL, dispatched_execution_id = NULL, dispatched_task_id = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE signature = ?
       AND queue_state = 'claimed'
       AND rejected_at IS NULL
       AND source <> '${REPORT_SOURCE}'
       AND incident_claim_token = ?
       AND incident_claimed_by_task_id = ?
       AND incident_claim_expires_at >= ?`
  )
    .bind(
      now,
      sanitizedReason,
      sanitizedReason,
      `$."${Math.floor(now / HOUR_MS)}"`,
      signature,
      claimToken,
      taskId,
      now
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Expires watched incidents with no occurrence for the quiet period. Runs after the hourly
 * runner has recorded this window's recurrences, so a signature that is still recurring has a
 * fresh `last_seen_at` and stays watched. `observedNotRecorded` lists watched signatures seen
 * in this window whose recording failed: they recurred, so they must not expire on a stale
 * `last_seen_at`. More of them than one statement can bind skips expiry for this run.
 */
export async function expireQuietWatchedIncidents(
  env: Env,
  now: number,
  config: Pick<WatchConfig, 'quietExpiryMs'>,
  observedNotRecorded: readonly string[] = []
): Promise<number> {
  const reserved = 2;
  if (observedNotRecorded.length > D1_MAX_BOUND_PARAMETERS - reserved) {
    log.warn('platform_feedback_incident.watch_expiry_skipped', {
      reason: 'too_many_unrecorded_recurrences',
      count: observedNotRecorded.length,
    });
    return 0;
  }
  const exclusion = observedNotRecorded.length
    ? `AND signature NOT IN (${observedNotRecorded.map(() => '?').join(', ')})`
    : '';
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET queue_state = 'expired', expired_at = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE queue_state = 'watching' AND last_seen_at < ? ${exclusion}`
  )
    .bind(now, now - config.quietExpiryMs, ...observedNotRecorded)
    .run();
  return result.meta.changes ?? 0;
}
