import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { persistError } from '../observability';
import {
  budgetMs,
  LIFECYCLE_WATCHES,
  type LifecycleLatencySettings,
  type LifecycleWatch,
  resolveLifecycleLatencySettings,
} from './watches';

const DAY_MS = 86_400_000;
const BASELINE_DAYS = 7;
/**
 * Rows deleted per purge statement, and statements per table per run. These bound one run's I/O,
 * not retention: up to 100k rows a day per table can be purged, against a few thousand
 * transitions a day in production (2026-11: ~6k workspaces and ~1.7k nodes created in total).
 * Anything left over is purged by the next run.
 */
const PURGE_BATCH_SIZE = 5_000;
const PURGE_MAX_BATCHES = 20;

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface LifecycleStateEvaluation {
  entityType: string;
  status: string;
  budgetMs: number;
  last24h: LatencyStats;
  previous7d: LatencyStats;
  /** True when the per-state sample limit cut off older episodes in the 8-day window. */
  truncated: boolean;
  regression: null | 'over_budget' | 'vs_baseline';
}

export interface LifecycleLatencyDailyResult {
  evaluations: LifecycleStateEvaluation[];
  regressions: number;
  purgedTransitions: number;
  purgedAlerts: number;
}

/** Nearest-rank percentile over an already sorted list. */
export function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

export function latencyStats(durations: number[]): LatencyStats {
  const sorted = [...durations].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.length ? (sorted[sorted.length - 1] ?? null) : null,
  };
}

/**
 * A state regresses when, with enough samples, its 24h p95 is over budget, or is more than
 * `regressionPercent` of its p95 over the previous 7 days.
 */
export function classifyRegression(
  last24h: LatencyStats,
  previous7d: LatencyStats,
  stateBudgetMs: number,
  settings: Pick<LifecycleLatencySettings, 'minSamples' | 'regressionPercent'>
): LifecycleStateEvaluation['regression'] {
  if (last24h.count < settings.minSamples || last24h.p95Ms === null) return null;
  if (stateBudgetMs > 0 && last24h.p95Ms > stateBudgetMs) return 'over_budget';
  if (
    previous7d.count >= settings.minSamples &&
    previous7d.p95Ms !== null &&
    previous7d.p95Ms > 0 &&
    last24h.p95Ms > previous7d.p95Ms * (settings.regressionPercent / 100)
  )
    return 'vs_baseline';
  return null;
}

export function regressionMessage(watch: LifecycleWatch): string {
  return `Lifecycle latency regression: ${watch.entityType} ${watch.status}`;
}

/**
 * Daily check over `lifecycle_state_transitions`: per watched state, p50/p95/max time spent in
 * that state over the last 24 hours against its budget and its previous 7 days. Regressions are
 * recorded in `platform_errors` for platform-feedback triage; a summary is always logged.
 *
 * I/O per run: one settings read, one SELECT per watched state (11), one observability insert
 * per regression, and at most `PURGE_MAX_BATCHES` deletes per purged table.
 */
export async function runLifecycleLatencyDailyEvaluation(
  env: Env,
  now: Date = new Date(),
  settingsOverride?: LifecycleLatencySettings
): Promise<LifecycleLatencyDailyResult> {
  const settings = settingsOverride ?? (await resolveLifecycleLatencySettings(env));
  const dayStart = now.getTime() - DAY_MS;
  const windowStart = new Date(now.getTime() - (BASELINE_DAYS + 1) * DAY_MS).toISOString();
  const sampleLimit = Math.max(1, settings.evaluationSampleLimit);
  const evaluations: LifecycleStateEvaluation[] = [];

  for (const watch of LIFECYCLE_WATCHES) {
    const { results } = await env.DATABASE.prepare(
      `SELECT changed_at,
              (julianday(changed_at) - julianday(entered_at)) * 86400000.0 AS duration_ms
         FROM lifecycle_state_transitions
        WHERE entity_type = ? AND from_status = ? AND entered_at IS NOT NULL AND changed_at >= ?
        ORDER BY changed_at DESC
        LIMIT ?`
    )
      .bind(watch.entityType, watch.status, windowStart, sampleLimit)
      .all<{ changed_at: string; duration_ms: number }>();
    const rows = (results ?? []).filter((row) => Number.isFinite(row.duration_ms));
    const recent: number[] = [];
    const baseline: number[] = [];
    for (const row of rows) {
      const duration = Math.max(0, Math.round(row.duration_ms));
      (Date.parse(row.changed_at) >= dayStart ? recent : baseline).push(duration);
    }
    const stateBudgetMs = budgetMs(settings, watch);
    const last24h = latencyStats(recent);
    const previous7d = latencyStats(baseline);
    evaluations.push({
      entityType: watch.entityType,
      status: watch.status,
      budgetMs: stateBudgetMs,
      last24h,
      previous7d,
      truncated: (results?.length ?? 0) >= sampleLimit,
      regression: classifyRegression(last24h, previous7d, stateBudgetMs, settings),
    });
  }

  let regressions = 0;
  for (const evaluation of evaluations) {
    if (!evaluation.regression) continue;
    regressions += 1;
    const watch = LIFECYCLE_WATCHES.find(
      (candidate) =>
        candidate.entityType === evaluation.entityType && candidate.status === evaluation.status
    );
    if (!watch) continue;
    log.warn('lifecycle_latency.regression', { ...evaluation });
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'warn',
        message: regressionMessage(watch),
        context: { ...evaluation, regressionPercent: settings.regressionPercent },
      },
      env
    );
  }

  const cutoff = new Date(now.getTime() - settings.retentionDays * DAY_MS).toISOString();
  const purgedTransitions = await purgeInBatches(
    env,
    `DELETE FROM lifecycle_state_transitions WHERE id IN (
       SELECT id FROM lifecycle_state_transitions WHERE changed_at < ? ORDER BY changed_at LIMIT ?)`,
    cutoff
  );
  const purgedAlerts = await purgeInBatches(
    env,
    `DELETE FROM lifecycle_latency_alerts WHERE rowid IN (
       SELECT rowid FROM lifecycle_latency_alerts WHERE alerted_at < ? ORDER BY alerted_at LIMIT ?)`,
    cutoff
  );

  log.info('lifecycle_latency.daily_summary', {
    regressions,
    purgedTransitions,
    purgedAlerts,
    states: evaluations.map((evaluation) => ({
      state: `${evaluation.entityType}.${evaluation.status}`,
      budgetMs: evaluation.budgetMs,
      n24h: evaluation.last24h.count,
      p50Ms: evaluation.last24h.p50Ms,
      p95Ms: evaluation.last24h.p95Ms,
      maxMs: evaluation.last24h.maxMs,
      baselineP95Ms: evaluation.previous7d.p95Ms,
      truncated: evaluation.truncated,
      regression: evaluation.regression,
    })),
  });
  return { evaluations, regressions, purgedTransitions, purgedAlerts };
}

async function purgeInBatches(env: Env, sql: string, cutoff: string): Promise<number> {
  let purged = 0;
  for (let batch = 0; batch < PURGE_MAX_BATCHES; batch++) {
    const result = await env.DATABASE.prepare(sql).bind(cutoff, PURGE_BATCH_SIZE).run();
    const changes = result.meta.changes ?? 0;
    purged += changes;
    if (changes < PURGE_BATCH_SIZE) break;
  }
  return purged;
}
