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

/** Newest rows read per (operation, phase) to compute percentiles. Callers may pass another cap. */
export const DEFAULT_PHASE_STATS_SAMPLE_LIMIT = 500;
export const MAX_PHASE_STATS_SAMPLE_LIMIT = 20_000;
/** Rows one stats read returns in total, whatever the number of phases (a memory bound). */
export const MAX_PHASE_STATS_TOTAL_ROWS = 20_000;
/**
 * Operations that can store one phase name: the VM vocabulary is shared by `workspace`, `sleep`
 * and `wake` (`provision` rows have no project); runner steps have their own operations. A phase
 * reads at most this many samples' worth of its newest rows, so every operation can fill its own
 * sample.
 */
export const PHASE_STATS_OPERATIONS_PER_PHASE = 3;
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
}

export interface PhaseDurationStatsResult {
  windowDays: number;
  /** True when a phase had more rows in the window than its sample cap, so older ones were left
   *  out, or when the total row bound was reached. Every phase still gets its newest rows. */
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
 * `idx_lifecycle_phase_timings_skill_phase` / `_profile_phase`.
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
  const phaseScanLimit = (sampleLimit + 1) * PHASE_STATS_OPERATIONS_PER_PHASE;

  // The database work is bounded by phases, not by history: the phase list comes from index
  // seeks (one per stored phase, or the caller's list), and each phase reads only its newest
  // `phaseScanLimit` rows in index order. A year of rows costs what a day costs.
  // The cap is per (operation, phase), never global: a newest-first LIMIT over every phase lets
  // one frequent phase crowd the others out of the sample (rule 65). One extra row per group shows
  // whether that group was cut, and a phase that filled its scan may have older rows unread. The
  // total bound is ordered by row number, so it trims every group's oldest rows first.
  const phaseList =
    phases === null
      ? `SELECT MIN(phase) FROM lifecycle_phase_timings
          WHERE project_id = ? AND ${byColumn} = ?
         UNION ALL
         SELECT (SELECT MIN(phase) FROM lifecycle_phase_timings
                  WHERE project_id = ? AND ${byColumn} = ? AND phase > phases.phase)
           FROM phases WHERE phases.phase IS NOT NULL`
      : `VALUES ${phases.map(() => '(?)').join(', ')}`;
  const operationFilter = input.operation !== undefined ? 'AND s.operation = ?' : '';
  const bindings: Array<string | number> = [
    ...(phases ?? [projectId, byId, projectId, byId]),
    projectId,
    byId,
    since,
  ];
  if (input.operation !== undefined) bindings.push(input.operation);
  bindings.push(phaseScanLimit, sampleLimit + 1, MAX_PHASE_STATS_TOTAL_ROWS);

  const result = await db
    .prepare(
      `WITH RECURSIVE phases(phase) AS (${phaseList}),
       sampled AS (
         SELECT t.id, t.operation, t.phase, t.duration_ms, t.created_at
           FROM phases p
           JOIN lifecycle_phase_timings t
             ON t.id IN (
               SELECT s.id FROM lifecycle_phase_timings s
                WHERE s.project_id = ?
                  AND s.${byColumn} = ?
                  AND s.phase = p.phase
                  AND s.created_at >= ?
                  AND s.outcome = 'success'
                  ${operationFilter}
                ORDER BY s.created_at DESC
                LIMIT ?)
          WHERE p.phase IS NOT NULL
       )
       SELECT operation, phase, duration_ms, rn, phase_rows FROM (
         SELECT operation, phase, duration_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY operation, phase ORDER BY created_at DESC, id DESC
                ) AS rn,
                COUNT(*) OVER (PARTITION BY phase) AS phase_rows
           FROM sampled
       )
       WHERE rn <= ?
       ORDER BY rn, operation, phase
       LIMIT ?`
    )
    .bind(...bindings)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];

  const groups = new Map<string, { operation: string; phase: string; durations: number[] }>();
  let truncated = rows.length >= MAX_PHASE_STATS_TOTAL_ROWS;
  for (const raw of rows) {
    if (typeof raw.phase_rows === 'number' && raw.phase_rows >= phaseScanLimit) truncated = true;
    if (typeof raw.rn === 'number' && raw.rn > sampleLimit) {
      truncated = true;
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
      };
    })
    .sort((a, b) => a.operation.localeCompare(b.operation) || a.phase.localeCompare(b.phase));
  return { windowDays, truncated, stats };
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
