/**
 * The history half of `GET /api/nodes/resource-usage`: which workspaces get history, the
 * bounded chunk read, and merging stored rollup buckets into one series per workspace.
 */
import type { NodeResourceUsageSeries } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { parseWorkspaceResourceRollup } from './workspace-resource-rollup';

/**
 * Three bound parameters per (project_id, workspace_id, started_at) branch, plus the window
 * start and the per-workspace chunk cap. The started_at bound sits inside each branch so
 * SQLite's OR optimisation can range scan the (project_id, workspace_id, started_at) index
 * instead of reading every chunk the workspace ever uploaded.
 */
export const CHUNK_BRANCHES_PER_STATEMENT = Math.floor((D1_MAX_BOUND_PARAMETERS - 2) / 3);

/** Workspace states that may still be producing history, ranked first when a read is capped. */
export const LIVE_STATUSES: readonly string[] = [
  'pending',
  'creating',
  'running',
  'recovery',
  'stopping',
];
const LIVE = new Set(LIVE_STATUSES);

export interface HistoryCandidateRow {
  id: string;
  node_id: string;
  project_id: string | null;
  status: string;
  updated_at: string | null;
}

export interface ChunkPair {
  projectId: string;
  workspaceId: string;
}

export function timestampMs(value: string | null): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Live first, then most recently changed, then id, so equal rows always rank the same way. */
function byPriority(a: HistoryCandidateRow, b: HistoryCandidateRow): number {
  return (
    Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) ||
    timestampMs(b.updated_at) - timestampMs(a.updated_at) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Which workspaces get history in this request: only ones that can have history in the window
 * (still live, or changed since the chunk lookback began), up to the cap. Within live and then
 * within the rest, each node's best workspace comes before any node's second, so one busy
 * machine cannot use up the cap and leave another machine's running session without history.
 * A stopped workspace untouched for days has no chunks in the window, so it costs no read.
 */
export function historyCandidates(
  rows: HistoryCandidateRow[],
  earliestChunkStart: number,
  max: number
): { pairs: ChunkPair[]; omittedIds: Set<string> } {
  const eligible = rows
    .filter((row): row is HistoryCandidateRow & { project_id: string } => row.project_id !== null)
    .filter((row) => LIVE.has(row.status) || timestampMs(row.updated_at) >= earliestChunkStart)
    .sort(byPriority);
  const rankOnNode = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const row of eligible) {
    const key = `${Number(LIVE.has(row.status))}:${row.node_id}`;
    const rank = seen.get(key) ?? 0;
    seen.set(key, rank + 1);
    rankOnNode.set(row.id, rank);
  }
  const ranked = [...eligible].sort(
    (a, b) =>
      Number(LIVE.has(b.status)) - Number(LIVE.has(a.status)) ||
      (rankOnNode.get(a.id) ?? 0) - (rankOnNode.get(b.id) ?? 0) ||
      byPriority(a, b)
  );
  return {
    pairs: ranked.slice(0, max).map((row) => ({ projectId: row.project_id, workspaceId: row.id })),
    omittedIds: new Set(ranked.slice(max).map((row) => row.id)),
  };
}

export interface ChunkRow {
  project_id: string;
  workspace_id: string;
  rollup_json: string | null;
  chunks_in_window: number;
}

/**
 * The window's chunks for each pair, newest first, at most `maxChunksPerWorkspace` each. Each
 * stored rollup is bounded by `WORKSPACE_RESOURCE_ROLLUP_MAX_BUCKETS`, so the cap bounds the
 * result size even for an agent that uploads many short chunks. `chunks_in_window` reports
 * how many the workspace had, so the caller can disclose a truncated history.
 */
export async function readChunkRows(
  env: Env,
  pairs: ChunkPair[],
  windowStart: number,
  earliestChunkStart: number,
  maxChunksPerWorkspace: number
): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = [];
  for (let i = 0; i < pairs.length; i += CHUNK_BRANCHES_PER_STATEMENT) {
    const batch = pairs.slice(i, i + CHUNK_BRANCHES_PER_STATEMENT);
    const predicate = batch
      .map(() => '(project_id = ? AND workspace_id = ? AND started_at > ?)')
      .join(' OR ');
    const result = await env.DATABASE.prepare(
      `SELECT project_id, workspace_id, rollup_json, chunks_in_window FROM (
         SELECT project_id, workspace_id, rollup_json,
                ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY started_at DESC, id DESC) AS rn,
                COUNT(*) OVER (PARTITION BY workspace_id) AS chunks_in_window
         FROM workspace_resource_chunks
         WHERE (${predicate}) AND ended_at > ? AND rollup_json IS NOT NULL
       ) WHERE rn <= ?`
    )
      .bind(
        ...batch.flatMap((pair) => [pair.projectId, pair.workspaceId, earliestChunkStart]),
        windowStart,
        maxChunksPerWorkspace
      )
      .all<ChunkRow>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

interface Bucket {
  cpuSum: number;
  cpuWeight: number;
  memorySum: number;
  memoryWeight: number;
}

/**
 * Accumulates rollup buckets that overlap the window, keyed by workspace then bucket start.
 * Each stored bucket is placed on the response's `bucketMs` grid by its midpoint, so buckets
 * written under an older rollup width still line up with the width the response reports.
 */
export class SeriesBuilder {
  private readonly buckets = new Map<string, Map<number, Bucket>>();
  private readonly ends = new Map<string, number>();

  constructor(
    private readonly windowStart: number,
    private readonly windowEnd: number,
    private readonly bucketMs: number
  ) {}

  add(workspaceId: string, rollupJson: string | null): boolean {
    const rollup = parseWorkspaceResourceRollup(rollupJson);
    if (!rollup) return false;
    let byStart = this.buckets.get(workspaceId);
    if (!byStart) {
      byStart = new Map();
      this.buckets.set(workspaceId, byStart);
    }
    for (let i = 0; i < rollup.start.length; i++) {
      const start = rollup.start[i] ?? 0;
      const end = rollup.end[i] ?? start + rollup.bucketMs;
      if (end <= this.windowStart || start > this.windowEnd) continue;
      const slot = Math.floor((start + end) / 2 / this.bucketMs) * this.bucketMs;
      // A bucket split across two chunks appears in both; weight each half by its samples.
      const weight = Math.max(1, rollup.samples[i] ?? 0);
      const bucket = byStart.get(slot) ?? {
        cpuSum: 0,
        cpuWeight: 0,
        memorySum: 0,
        memoryWeight: 0,
      };
      const cpu = rollup.cpuMeanCores[i];
      if (cpu != null) {
        bucket.cpuSum += cpu * 1000 * weight;
        bucket.cpuWeight += weight;
      }
      const memory = rollup.memoryMeanBytes[i];
      if (memory != null) {
        bucket.memorySum += memory * weight;
        bucket.memoryWeight += weight;
      }
      byStart.set(slot, bucket);
      this.ends.set(workspaceId, Math.max(this.ends.get(workspaceId) ?? 0, end));
    }
    return true;
  }

  series(workspaceId: string): { series: NodeResourceUsageSeries; historyEndsAt: number | null } {
    const byStart = this.buckets.get(workspaceId);
    const starts = byStart ? [...byStart.keys()].sort((a, b) => a - b) : [];
    const series: NodeResourceUsageSeries = { start: [], cpuMillis: [], memoryBytes: [] };
    for (const start of starts) {
      const bucket = byStart?.get(start);
      if (!bucket) continue;
      series.start.push(start);
      series.cpuMillis.push(
        bucket.cpuWeight > 0 ? Math.round(bucket.cpuSum / bucket.cpuWeight) : null
      );
      series.memoryBytes.push(
        bucket.memoryWeight > 0 ? Math.round(bucket.memorySum / bucket.memoryWeight) : null
      );
    }
    return { series, historyEndsAt: this.ends.get(workspaceId) ?? null };
  }
}
