/**
 * Shared reads over `lifecycle_phase_timings` (Insights slice T, idea 01M7HTS38KX2G78JD0ESAGMKKH)
 * for later Insights surfaces: the run receipt's "setup took 2.3x this skill's usual" and the
 * Agent setups tab. Rows are written by `recordLifecycleTimings` / `recordRunnerPhase` in the
 * worker and purged by the daily lifecycle latency evaluation.
 *
 * These are cores, not operations: they take the project the caller has already authorized
 * (`authorizeProjectOperation`) and put it in every SQL predicate, so a task, workspace, skill or
 * profile id from another project matches nothing (rule 11). Missing and foreign ids both return
 * an empty result. Provision rows are node-level (no project) and are never returned here.
 *
 * Round trips: one query each.
 */
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { OperationError } from './errors';

const DAY_MS = 86_400_000;

/**
 * Newest rows read per (operation, phase) to compute percentiles. Callers may pass another cap.
 * Work bound (rule 81): pairs come from a closed vocabulary (the VM phases under workspace, sleep
 * and wake, plus runner steps under runner_start and runner_wake; about 30 pairs per skill or
 * profile in practice). One call reads at most pairs x (sample + 1) index entries and rows: about
 * 15k at the default, 60k at the maximum, whatever the retained history.
 */
export const DEFAULT_PHASE_STATS_SAMPLE_LIMIT = 500;
export const MAX_PHASE_STATS_SAMPLE_LIMIT = 2_000;
/** Rows one stats read returns in total, whatever the number of phases (a memory bound). */
export const MAX_PHASE_STATS_TOTAL_ROWS = 20_000;
export const DEFAULT_PHASE_STATS_WINDOW_DAYS = 30;
export const MAX_PHASE_STATS_WINDOW_DAYS = 365;
/** Distinct phases one stats call may ask for (the VM vocabulary plus runner steps fit). */
export const MAX_PHASE_STATS_PHASES = 64;
export const DEFAULT_PHASE_TIMING_LIST_LIMIT = 200;
export const MAX_PHASE_TIMING_LIST_LIMIT = 1_000;

export interface PhaseDurationStatsInput {
  projectId: string;
  /** Exactly one of skillId / agentProfileId. */
  skillId?: string;
  agentProfileId?: string;
  /** Phases to summarise, e.g. `['git_clone', 'devcontainer_up']`. Omitted: every stored phase. */
  phases?: readonly string[];
  /** Restrict to one operation (`workspace`, `wake`, `runner_start`, ...). Default: all. */
  operation?: string;
  /** Rows older than `lifecycleLatency.retentionDays` (default 30) are purged, so a longer window
   *  returns at most the retained days. */
  windowDays?: number;
  /** Newest successful rows read per (operation, phase). */
  sampleLimit?: number;
  now?: number;
}

export interface PhaseDurationStat {
  operation: string;
  phase: string;
  count: number;
  medianMs: number;
  p90Ms: number;
  /** This pair had more successful rows in the window than its sample: median and p90 are over
   *  its newest `count` rows. Also true for every pair when the total row bound was reached. */
  truncated: boolean;
}

export interface PhaseDurationStatsResult {
  windowDays: number;
  /** True when any stat is `truncated`. Every pair still gets its newest rows. */
  truncated: boolean;
  /** Only phases with at least one successful sample; ordered by operation, then phase. */
  stats: PhaseDurationStat[];
}

export interface PhaseTimingRow {
  operation: string;
  phase: string;
  outcome: string;
  durationMs: number;
  workspaceId: string | null;
  nodeId: string | null;
  chatSessionId: string | null;
  taskId: string | null;
  skillId: string | null;
  agentProfileId: string | null;
  createdAt: string;
}

export interface ListPhaseTimingsInput {
  projectId: string;
  /** Exactly one of taskId / workspaceId. */
  taskId?: string;
  workspaceId?: string;
  limit?: number;
}

const DurationRowSchema = v.object({
  operation: v.string(),
  phase: v.string(),
  duration_ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const nullableString = v.nullable(v.string());
const TimingRowSchema = v.object({
  operation: v.string(),
  phase: v.string(),
  outcome: v.string(),
  duration_ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
  workspace_id: nullableString,
  node_id: nullableString,
  chat_session_id: nullableString,
  task_id: nullableString,
  skill_id: nullableString,
  agent_profile_id: nullableString,
  created_at: v.pipe(v.number(), v.integer()),
});

function requireId(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OperationError('invalid_input', `${name} is required`);
  }
  return value;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) {
    throw new OperationError('invalid_input', 'Limits and windows must be positive numbers');
  }
  return Math.min(max, Math.floor(value));
}

/** Nearest-rank percentile over an ascending list (same rule as the lifecycle latency check). */
export function nearestRankPercentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

/**
 * Median and p90 duration per phase for one skill or one profile in one project over the last
 * `windowDays`, from successful phases only (a failed phase's time says nothing about the usual),
 * over at most `sampleLimit` newest rows per (operation, phase). One query on
 * `idx_lifecycle_phase_timings_skill_pair` / `_profile_pair` (migration 0260).
 */
export async function phaseDurationStats(
  db: D1Database,
  input: PhaseDurationStatsInput
): Promise<PhaseDurationStatsResult> {
  const projectId = requireId(input.projectId, 'projectId');
  if ((input.skillId === undefined) === (input.agentProfileId === undefined)) {
    throw new OperationError('invalid_input', 'Pass exactly one of skillId or agentProfileId');
  }
  const byColumn = input.skillId !== undefined ? 'skill_id' : 'agent_profile_id';
  const byId = requireId(input.skillId ?? input.agentProfileId, byColumn);
  const phases = input.phases === undefined ? null : [...new Set(input.phases)];
  if (phases !== null && (phases.length === 0 || phases.length > MAX_PHASE_STATS_PHASES)) {
    throw new OperationError(
      'invalid_input',
      `Pass between 1 and ${MAX_PHASE_STATS_PHASES} phases`
    );
  }
  const windowDays = clampInt(
    input.windowDays,
    DEFAULT_PHASE_STATS_WINDOW_DAYS,
    MAX_PHASE_STATS_WINDOW_DAYS
  );
  const sampleLimit = clampInt(
    input.sampleLimit,
    DEFAULT_PHASE_STATS_SAMPLE_LIMIT,
    MAX_PHASE_STATS_SAMPLE_LIMIT
  );
  const since = (input.now ?? Date.now()) - windowDays * DAY_MS;

  // The database work is bounded by the (operation, phase) pairs, not by history. The pairs come
  // from index seeks, one per stored pair. Each pair's sample is one range of the pair index,
  // whose key holds every filter (operation, phase, outcome, created_at), so it reads its newest
  // successful rows and stops at its LIMIT: a year of rows costs what a day costs, and a rare
  // operation or a run of failures cannot make it walk further.
  // The cap is per (operation, phase), never global: a newest-first LIMIT over every phase lets
  // one frequent group crowd the others out of the sample (rule 65). One extra row per group shows
  // whether that group was cut. The total bound is ordered by row number, so it trims every
  // group's oldest rows first.
  // Pairs are listed in index order with MIN seeks, never with a row-value comparison, which
  // SQLite seeks on its first column only (and would re-walk the current operation's rows each
  // step): the next phase of the same operation, else the first phase of the next operation.
  const scope = `project_id = ? AND ${byColumn} = ?`;
  const nextPhase = `(SELECT MIN(phase) FROM lifecycle_phase_timings
     WHERE ${scope} AND operation = pairs.operation AND phase > pairs.phase)`;
  const nextOperation = `(SELECT MIN(operation) FROM lifecycle_phase_timings
     WHERE ${scope} AND operation > pairs.operation)`;
  const phaseFilter = phases === null ? '' : `AND p.phase IN (${phases.map(() => '?').join(', ')})`;
  const operationFilter = input.operation !== undefined ? 'AND p.operation = ?' : '';
  const scopeBinds = [projectId, byId];
  const bindings: Array<string | number> = [
    // Anchor: the first operation, then its first phase.
    ...scopeBinds,
    ...scopeBinds,
    // Step: nextPhase twice, nextOperation twice, then the next operation's first phase.
    ...scopeBinds,
    ...scopeBinds,
    ...scopeBinds,
    ...scopeBinds,
    ...scopeBinds,
    // Each pair's sample: the row's own project (defence in depth), then the index range.
    projectId,
    ...scopeBinds,
    since,
    sampleLimit + 1,
    ...(phases ?? []),
  ];
  if (input.operation !== undefined) bindings.push(input.operation);
  bindings.push(MAX_PHASE_STATS_TOTAL_ROWS);

  const result = await db
    .prepare(
      `WITH RECURSIVE pairs(operation, phase) AS (
         SELECT first.operation,
                (SELECT MIN(phase) FROM lifecycle_phase_timings
                  WHERE ${scope} AND operation = first.operation)
           FROM (SELECT MIN(operation) AS operation FROM lifecycle_phase_timings
                  WHERE ${scope}) AS first
         UNION ALL
         SELECT CASE WHEN ${nextPhase} IS NOT NULL THEN pairs.operation ELSE ${nextOperation} END,
                COALESCE(
                  ${nextPhase},
                  (SELECT MIN(phase) FROM lifecycle_phase_timings
                    WHERE ${scope} AND operation = ${nextOperation})
                )
           FROM pairs WHERE pairs.operation IS NOT NULL
       ),
       sampled AS (
         SELECT t.id, t.operation, t.phase, t.duration_ms, t.created_at
           FROM pairs p
           -- CROSS JOIN fixes the loop order: pairs outside, rows by id inside. D1 keeps no
           -- planner statistics, and a plain JOIN let SQLite scan the whole table instead.
           CROSS JOIN lifecycle_phase_timings t
             ON t.project_id = ?
            AND t.id IN (
               SELECT s.id FROM lifecycle_phase_timings s
                WHERE s.project_id = ?
                  AND s.${byColumn} = ?
                  AND s.operation = p.operation
                  AND s.phase = p.phase
                  AND s.outcome = 'success'
                  AND s.created_at >= ?
                ORDER BY s.created_at DESC
                LIMIT ?)
          WHERE p.operation IS NOT NULL
            ${phaseFilter}
            ${operationFilter}
       )
       SELECT operation, phase, duration_ms, rn FROM (
         SELECT operation, phase, duration_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY operation, phase ORDER BY created_at DESC, id DESC
                ) AS rn
           FROM sampled
       )
       ORDER BY rn, operation, phase
       LIMIT ?`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];

  const groups = new Map<string, { operation: string; phase: string; durations: number[] }>();
  // The total bound trims by row number across every pair, so when it is reached no pair can be
  // shown to be complete.
  const totalBoundReached = rows.length >= MAX_PHASE_STATS_TOTAL_ROWS;
  const cutPairs = new Set<string>();
  for (const raw of rows) {
    if (typeof raw.rn === 'number' && raw.rn > sampleLimit) {
      cutPairs.add(`${String(raw.operation)}\u0000${String(raw.phase)}`);
      continue;
    }
    // One malformed row costs that row, not the read (`apps/api/.claude/rules/50`).
    const parsed = v.safeParse(DurationRowSchema, raw);
    if (!parsed.success) {
      log.error('insights_phase_timings.row_skipped', {
        projectId,
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
      continue;
    }
    const { operation, phase, duration_ms: durationMs } = parsed.output;
    const key = `${operation}\u0000${phase}`;
    const group = groups.get(key) ?? { operation, phase, durations: [] };
    group.durations.push(durationMs);
    groups.set(key, group);
  }

  const stats = [...groups.values()]
    .map(({ operation, phase, durations }) => {
      const sorted = durations.sort((left, right) => left - right);
      return {
        operation,
        phase,
        count: sorted.length,
        medianMs: nearestRankPercentile(sorted, 0.5),
        p90Ms: nearestRankPercentile(sorted, 0.9),
        truncated: totalBoundReached || cutPairs.has(`${operation}\u0000${phase}`),
      };
    })
    .sort((a, b) => a.operation.localeCompare(b.operation) || a.phase.localeCompare(b.phase));
  return { windowDays, truncated: stats.some((stat) => stat.truncated), stats };
}

/**
 * Every stored phase of one task or one workspace in one project, oldest first (VM agent phases
 * and runner steps interleaved by time). One query on `idx_lifecycle_phase_timings_task` /
 * `_workspace`.
 */
export async function listPhaseTimings(
  db: D1Database,
  input: ListPhaseTimingsInput
): Promise<PhaseTimingRow[]> {
  const projectId = requireId(input.projectId, 'projectId');
  if ((input.taskId === undefined) === (input.workspaceId === undefined)) {
    throw new OperationError('invalid_input', 'Pass exactly one of taskId or workspaceId');
  }
  const byColumn = input.taskId !== undefined ? 'task_id' : 'workspace_id';
  const byId = requireId(input.taskId ?? input.workspaceId, byColumn);
  const limit = clampInt(input.limit, DEFAULT_PHASE_TIMING_LIST_LIMIT, MAX_PHASE_TIMING_LIST_LIMIT);

  // Newest `limit` rows, returned oldest first.
  const result = await db
    .prepare(
      `SELECT * FROM (
         SELECT id, operation, phase, outcome, duration_ms, workspace_id, node_id, chat_session_id,
                task_id, skill_id, agent_profile_id, created_at
           FROM lifecycle_phase_timings
          WHERE ${byColumn} = ? AND project_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?)
        ORDER BY created_at ASC, id ASC`
    )
    .bind(byId, projectId, limit)
    .all<Record<string, unknown>>();

  const items: PhaseTimingRow[] = [];
  for (const raw of result.results ?? []) {
    const parsed = v.safeParse(TimingRowSchema, raw);
    if (!parsed.success) {
      log.error('insights_phase_timings.row_skipped', {
        projectId,
        issue: parsed.issues[0]?.message ?? 'invalid row',
        action: 'skipped',
      });
      continue;
    }
    const row = parsed.output;
    items.push({
      operation: row.operation,
      phase: row.phase,
      outcome: row.outcome,
      durationMs: row.duration_ms,
      workspaceId: row.workspace_id,
      nodeId: row.node_id,
      chatSessionId: row.chat_session_id,
      taskId: row.task_id,
      skillId: row.skill_id,
      agentProfileId: row.agent_profile_id,
      createdAt: new Date(row.created_at).toISOString(),
    });
  }
  return items;
}
