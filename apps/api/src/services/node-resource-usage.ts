/**
 * CPU and memory per workspace for the Nodes page (`GET /api/nodes/resource-usage`).
 *
 * One joined read finds the caller's own workspaces on the caller's own nodes, with the
 * chat topic, task title, project name and session creator from D1 (no ProjectData DO
 * calls). Then the per-minute rollups of their resource-history chunks that overlap the
 * window are read from D1 in batches of (project_id, workspace_id) pairs, which match the
 * chunk index. Raw samples in R2 are never read.
 *
 * History arrives in batches: the VM agent uploads a chunk every 15 minutes by default,
 * so the newest minutes are missing until the next upload. Live memory comes from the
 * heartbeat (`nodes.last_metrics.workspaceMemory`) and is returned by `GET /api/nodes`.
 *
 * I/O per request: the admin settings (cached per isolate), one workspace query, and
 * ceil(history workspaces / CHUNK_BRANCHES_PER_STATEMENT) chunk queries. History workspaces
 * are capped by `nodes.usageMaxHistoryWorkspaces` (default 150, so at most 5 chunk queries)
 * and each chunk query is bounded by time, reading about (window + lookback) / 15 minutes
 * chunks per workspace: 8 at the defaults, whatever the workspace's age.
 */
import type {
  NodeResourceReservation,
  NodeResourceUsageResponse,
  NodeResourceUsageSeries,
  NodeWorkspaceResourceUsage,
  WorkspaceStatus,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import {
  DEFAULT_NODE_USAGE_CHUNK_LOOKBACK_MINUTES,
  DEFAULT_NODE_USAGE_MAX_HISTORY_WORKSPACES,
  DEFAULT_NODE_USAGE_WINDOW_MINUTES,
} from './admin-setting-definitions';
import { resolveAdminSetting } from './admin-settings';
import { parseStoredResolvedReservationJson } from './resource-requirements-input';
import { getRollupConfig, parseWorkspaceResourceRollup } from './workspace-resource-rollup';

const MINUTE_MS = 60_000;
/**
 * Three bound parameters per (project_id, workspace_id, started_at) branch, plus the window
 * start. The started_at bound sits inside each branch so SQLite's OR optimisation can range
 * scan the (project_id, workspace_id, started_at) index instead of reading every chunk the
 * workspace ever uploaded.
 */
const CHUNK_BRANCHES_PER_STATEMENT = Math.floor((D1_MAX_BOUND_PARAMETERS - 1) / 3);

/** Workspace states that may still be producing history, ranked first when the read is capped. */
const LIVE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'creating',
  'running',
  'recovery',
  'stopping',
]);

async function positiveIntegerSetting(
  env: Env,
  name:
    | 'nodes.usageWindowMinutes'
    | 'nodes.usageChunkLookbackMinutes'
    | 'nodes.usageMaxHistoryWorkspaces',
  fallback: number
): Promise<number> {
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Admin setting `nodes.usageWindowMinutes`; degrades to the default on a store outage. */
export function getNodeUsageWindowMinutes(env: Env): Promise<number> {
  return positiveIntegerSetting(env, 'nodes.usageWindowMinutes', DEFAULT_NODE_USAGE_WINDOW_MINUTES);
}

interface WorkspaceRow {
  id: string;
  node_id: string;
  project_id: string | null;
  chat_session_id: string | null;
  name: string;
  display_name: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  resolved_reservation_json: string | null;
  workspace_user_id: string;
  project_name: string | null;
  session_topic: string | null;
  session_creator_id: string | null;
  task_title: string | null;
  owner_name: string | null;
}

interface ChunkRow {
  project_id: string;
  workspace_id: string;
  rollup_json: string | null;
}

/**
 * The caller's non-deleted workspaces on the caller's non-deleted nodes. Both ownership
 * predicates are in the query; the session and task joins are scoped to the workspace's
 * project so a stale link cannot pull a title from another project.
 */
const WORKSPACES_SQL = `
SELECT w.id, w.node_id, w.project_id, w.chat_session_id, w.name, w.display_name, w.status,
       w.created_at, w.updated_at, w.resolved_reservation_json, w.user_id AS workspace_user_id,
       p.name AS project_name,
       ss.topic AS session_topic, ss.created_by_user_id AS session_creator_id,
       t.title AS task_title,
       u.name AS owner_name
FROM workspaces w
JOIN nodes n ON n.id = w.node_id AND n.user_id = ? AND n.status != 'deleted'
LEFT JOIN projects p ON p.id = w.project_id
LEFT JOIN session_summaries ss ON ss.id = w.chat_session_id AND ss.project_id = w.project_id
LEFT JOIN tasks t ON t.chat_session_id = w.chat_session_id AND t.project_id = w.project_id
LEFT JOIN users u ON u.id = COALESCE(ss.created_by_user_id, w.user_id)
WHERE w.user_id = ? AND w.status != 'deleted'
ORDER BY w.created_at DESC`;

function reservationOf(row: WorkspaceRow): NodeResourceReservation | null {
  try {
    const reservation = parseStoredResolvedReservationJson(row.resolved_reservation_json);
    return reservation
      ? {
          cpuMillis: reservation.cpuMillis,
          memoryMb: reservation.memoryMb,
          diskMb: reservation.diskMb,
          exclusiveNode: reservation.exclusiveNode,
        }
      : null;
  } catch (error) {
    // A malformed reservation hides that workspace's dashed lines; it must not fail the page.
    log.warn('node_usage.reservation_skipped', {
      workspaceId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function titleOf(row: WorkspaceRow): string {
  return (
    row.session_topic?.trim() || row.task_title?.trim() || row.display_name?.trim() || row.name
  );
}

interface Bucket {
  cpuSum: number;
  cpuWeight: number;
  memorySum: number;
  memoryWeight: number;
}

/** Accumulates rollup buckets that overlap the window, keyed by workspace then bucket start. */
class SeriesBuilder {
  private readonly buckets = new Map<string, Map<number, Bucket>>();
  private readonly ends = new Map<string, number>();

  constructor(
    private readonly windowStart: number,
    private readonly windowEnd: number
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
      // A bucket split across two chunks appears in both; weight each half by its samples.
      const weight = Math.max(1, rollup.samples[i] ?? 0);
      const bucket = byStart.get(start) ?? {
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
      byStart.set(start, bucket);
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

async function readChunkRows(
  env: Env,
  pairs: Array<{ projectId: string; workspaceId: string }>,
  windowStart: number,
  earliestChunkStart: number
): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = [];
  for (let i = 0; i < pairs.length; i += CHUNK_BRANCHES_PER_STATEMENT) {
    const batch = pairs.slice(i, i + CHUNK_BRANCHES_PER_STATEMENT);
    const predicate = batch
      .map(() => '(project_id = ? AND workspace_id = ? AND started_at > ?)')
      .join(' OR ');
    const result = await env.DATABASE.prepare(
      `SELECT project_id, workspace_id, rollup_json
       FROM workspace_resource_chunks
       WHERE (${predicate}) AND ended_at > ? AND rollup_json IS NOT NULL`
    )
      .bind(
        ...batch.flatMap((pair) => [pair.projectId, pair.workspaceId, earliestChunkStart]),
        windowStart
      )
      .all<ChunkRow>();
    rows.push(...(result.results ?? []));
  }
  return rows;
}

function timestampMs(value: string | null): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Which workspaces get history in this request: only ones that can have history in the window
 * (still live, or changed since the chunk lookback began), live ones first, then most
 * recently changed, up to the cap. A stopped workspace untouched for days has no chunks in
 * the window, so it costs no read.
 */
function historyCandidates(
  rows: WorkspaceRow[],
  earliestChunkStart: number,
  max: number
): { pairs: Array<{ projectId: string; workspaceId: string }>; omittedIds: Set<string> } {
  const eligible = rows
    .filter((row): row is WorkspaceRow & { project_id: string } => row.project_id !== null)
    .filter(
      (row) => LIVE_STATUSES.has(row.status) || timestampMs(row.updated_at) >= earliestChunkStart
    )
    .sort(
      (a, b) =>
        Number(LIVE_STATUSES.has(b.status)) - Number(LIVE_STATUSES.has(a.status)) ||
        timestampMs(b.updated_at) - timestampMs(a.updated_at)
    );
  return {
    pairs: eligible
      .slice(0, max)
      .map((row) => ({ projectId: row.project_id, workspaceId: row.id })),
    omittedIds: new Set(eligible.slice(max).map((row) => row.id)),
  };
}

export async function getNodeResourceUsage(
  env: Env,
  userId: string,
  now: number = Date.now()
): Promise<NodeResourceUsageResponse> {
  const [windowMinutes, lookbackMinutes, maxHistoryWorkspaces] = await Promise.all([
    getNodeUsageWindowMinutes(env),
    positiveIntegerSetting(
      env,
      'nodes.usageChunkLookbackMinutes',
      DEFAULT_NODE_USAGE_CHUNK_LOOKBACK_MINUTES
    ),
    positiveIntegerSetting(
      env,
      'nodes.usageMaxHistoryWorkspaces',
      DEFAULT_NODE_USAGE_MAX_HISTORY_WORKSPACES
    ),
  ]);
  const windowStart = now - windowMinutes * MINUTE_MS;
  const earliestChunkStart = windowStart - lookbackMinutes * MINUTE_MS;
  const { bucketMs } = getRollupConfig(env);

  const workspaceRows =
    (await env.DATABASE.prepare(WORKSPACES_SQL).bind(userId, userId).all<WorkspaceRow>()).results ??
    [];

  const { pairs, omittedIds } = historyCandidates(
    workspaceRows,
    earliestChunkStart,
    maxHistoryWorkspaces
  );
  const omitted = omittedIds.size;
  const projectOf = new Map(pairs.map((pair) => [pair.workspaceId, pair.projectId]));
  if (omitted > 0) {
    log.warn('node_usage.history_capped', {
      userId,
      read: pairs.length,
      omitted,
      maxHistoryWorkspaces,
    });
  }

  const builder = new SeriesBuilder(windowStart, now);
  for (const chunk of await readChunkRows(env, pairs, windowStart, earliestChunkStart)) {
    // Defence in depth: the predicate already pairs project and workspace.
    if (projectOf.get(chunk.workspace_id) !== chunk.project_id) continue;
    if (!builder.add(chunk.workspace_id, chunk.rollup_json)) {
      log.warn('node_usage.rollup_skipped', {
        workspaceId: chunk.workspace_id,
        projectId: chunk.project_id,
      });
    }
  }

  const workspaces: NodeWorkspaceResourceUsage[] = workspaceRows.map((row) => {
    const ownerUserId = row.session_creator_id ?? row.workspace_user_id;
    const { series, historyEndsAt } = builder.series(row.id);
    return {
      workspaceId: row.id,
      nodeId: row.node_id,
      projectId: row.project_id,
      projectName: row.project_name,
      chatSessionId: row.chat_session_id,
      title: titleOf(row),
      ownerUserId,
      ownerName: row.owner_name,
      isMine: ownerUserId === userId,
      status: row.status as WorkspaceStatus,
      createdAt: row.created_at,
      reservation: reservationOf(row),
      series,
      historyEndsAt,
      historyOmitted: omittedIds.has(row.id),
    };
  });

  return {
    windowMinutes,
    windowStart,
    windowEnd: now,
    bucketMs,
    historyOmittedCount: omitted,
    workspaces,
  };
}
