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
 * Project fields (project name, chat topic, task title, chat link, session creator) are
 * returned only for projects the caller is an active member of. A workspace stays on the
 * caller's own node after they leave its project, and its usage is still theirs to see, but
 * the project's data is not.
 *
 * I/O per request: the admin settings (cached per isolate), one workspace query capped at
 * `nodes.usageMaxWorkspaces` (default 500), and ceil(history workspaces /
 * CHUNK_BRANCHES_PER_STATEMENT) chunk queries. History workspaces are capped by
 * `nodes.usageMaxHistoryWorkspaces` (default 150, so at most 5 chunk queries). Each chunk query
 * is bounded by time, about (window + lookback) / 15 minutes chunks per workspace (8 at the
 * defaults, whatever the workspace's age), and by `nodes.usageMaxChunksPerWorkspace` rows.
 * Every cap that drops something is disclosed in the response.
 */
import type {
  NodeResourceReservation,
  NodeResourceUsageResponse,
  NodeWorkspaceResourceUsage,
  WorkspaceStatus,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  DEFAULT_NODE_USAGE_CHUNK_LOOKBACK_MINUTES,
  DEFAULT_NODE_USAGE_MAX_CHUNKS_PER_WORKSPACE,
  DEFAULT_NODE_USAGE_MAX_HISTORY_WORKSPACES,
  DEFAULT_NODE_USAGE_MAX_WORKSPACES,
  DEFAULT_NODE_USAGE_WINDOW_MINUTES,
} from './admin-setting-definitions';
import { resolveAdminSetting } from './admin-settings';
import {
  historyCandidates,
  LIVE_STATUSES,
  readChunkRows,
  SeriesBuilder,
} from './node-resource-usage-history';
import { parseStoredResolvedReservationJson } from './resource-requirements-input';
import { ACTIVE_WORKSPACE_RESERVATION_STATUSES } from './workspace-resource-capacity';
import { getRollupConfig } from './workspace-resource-rollup';

const MINUTE_MS = 60_000;
const HOLDS_RESERVATION: ReadonlySet<string> = new Set(ACTIVE_WORKSPACE_RESERVATION_STATUSES);

type UsageSettingName =
  | 'nodes.usageWindowMinutes'
  | 'nodes.usageChunkLookbackMinutes'
  | 'nodes.usageMaxHistoryWorkspaces'
  | 'nodes.usageMaxWorkspaces'
  | 'nodes.usageMaxChunksPerWorkspace';

async function positiveIntegerSetting(
  env: Env,
  name: UsageSettingName,
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
  project_access: number;
  project_name: string | null;
  session_topic: string | null;
  session_creator_id: string | null;
  task_title: string | null;
  owner_name: string | null;
}

const LIVE_STATUS_SQL = LIVE_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * The caller's non-deleted workspaces on the caller's non-deleted nodes, live first, then most
 * recently changed, at most `?` rows. Both ownership predicates are in the query. Project rows,
 * chat topics and task titles join only through the caller's active membership of the
 * workspace's project, and the session and task joins are scoped to that project so a stale
 * link cannot pull a title from another project.
 */
const WORKSPACES_SQL = `
SELECT w.id, w.node_id, w.project_id, w.chat_session_id, w.name, w.display_name, w.status,
       w.created_at, w.updated_at, w.resolved_reservation_json, w.user_id AS workspace_user_id,
       CASE WHEN pm.user_id IS NULL THEN 0 ELSE 1 END AS project_access,
       p.name AS project_name,
       ss.topic AS session_topic, ss.created_by_user_id AS session_creator_id,
       t.title AS task_title,
       u.name AS owner_name
FROM workspaces w
JOIN nodes n ON n.id = w.node_id AND n.user_id = ? AND n.status != 'deleted'
LEFT JOIN project_members pm
  ON pm.project_id = w.project_id AND pm.user_id = ? AND pm.status = 'active'
LEFT JOIN projects p ON p.id = w.project_id AND pm.user_id IS NOT NULL
LEFT JOIN session_summaries ss
  ON ss.id = w.chat_session_id AND ss.project_id = w.project_id AND pm.user_id IS NOT NULL
LEFT JOIN tasks t
  ON t.chat_session_id = w.chat_session_id AND t.project_id = w.project_id AND pm.user_id IS NOT NULL
LEFT JOIN users u ON u.id = COALESCE(ss.created_by_user_id, w.user_id)
WHERE w.user_id = ? AND w.status != 'deleted'
ORDER BY CASE WHEN w.status IN (${LIVE_STATUS_SQL}) THEN 0 ELSE 1 END, w.updated_at DESC, w.id
LIMIT ?`;

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

/**
 * Chat topic, then task title, then the workspace's own name. Without project access the
 * names can carry the project's task titles, so a neutral label is used instead.
 */
function titleOf(row: WorkspaceRow): string {
  if (!row.project_access && row.project_id) {
    return `Workspace ${row.id.slice(-6).toLowerCase()}`;
  }
  return (
    row.session_topic?.trim() || row.task_title?.trim() || row.display_name?.trim() || row.name
  );
}

export async function getNodeResourceUsage(
  env: Env,
  userId: string,
  now: number = Date.now()
): Promise<NodeResourceUsageResponse> {
  const [windowMinutes, lookbackMinutes, maxHistoryWorkspaces, maxWorkspaces, maxChunks] =
    await Promise.all([
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
      positiveIntegerSetting(env, 'nodes.usageMaxWorkspaces', DEFAULT_NODE_USAGE_MAX_WORKSPACES),
      positiveIntegerSetting(
        env,
        'nodes.usageMaxChunksPerWorkspace',
        DEFAULT_NODE_USAGE_MAX_CHUNKS_PER_WORKSPACE
      ),
    ]);
  const windowStart = now - windowMinutes * MINUTE_MS;
  const earliestChunkStart = windowStart - lookbackMinutes * MINUTE_MS;
  const { bucketMs } = getRollupConfig(env);

  // One extra row says whether the cap dropped anything.
  const fetched =
    (
      await env.DATABASE.prepare(WORKSPACES_SQL)
        .bind(userId, userId, userId, maxWorkspaces + 1)
        .all<WorkspaceRow>()
    ).results ?? [];
  const workspacesOmitted = fetched.length > maxWorkspaces;
  const workspaceRows = workspacesOmitted ? fetched.slice(0, maxWorkspaces) : fetched;
  if (workspacesOmitted) {
    log.warn('node_usage.workspaces_capped', { userId, maxWorkspaces });
  }

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

  const builder = new SeriesBuilder(windowStart, now, bucketMs);
  const truncatedIds = new Set<string>();
  for (const chunk of await readChunkRows(env, pairs, windowStart, earliestChunkStart, maxChunks)) {
    // Defence in depth: the predicate already pairs project and workspace.
    if (projectOf.get(chunk.workspace_id) !== chunk.project_id) continue;
    if (chunk.chunks_in_window > maxChunks) truncatedIds.add(chunk.workspace_id);
    if (!builder.add(chunk.workspace_id, chunk.rollup_json)) {
      log.warn('node_usage.rollup_skipped', {
        workspaceId: chunk.workspace_id,
        projectId: chunk.project_id,
      });
    }
  }
  if (truncatedIds.size > 0) {
    log.warn('node_usage.chunks_capped', { userId, workspaces: truncatedIds.size, maxChunks });
  }

  const workspaces: NodeWorkspaceResourceUsage[] = workspaceRows.map((row) => {
    const access = row.project_access === 1;
    const ownerUserId = row.session_creator_id ?? row.workspace_user_id;
    const { series, historyEndsAt } = builder.series(row.id);
    return {
      workspaceId: row.id,
      nodeId: row.node_id,
      projectId: access ? row.project_id : null,
      projectName: access ? row.project_name : null,
      chatSessionId: access ? row.chat_session_id : null,
      title: titleOf(row),
      ownerUserId,
      ownerName: row.owner_name,
      isMine: ownerUserId === userId,
      status: row.status as WorkspaceStatus,
      holdsReservation: HOLDS_RESERVATION.has(row.status),
      createdAt: row.created_at,
      reservation: reservationOf(row),
      series,
      historyEndsAt,
      historyOmitted: omittedIds.has(row.id),
      historyTruncated: truncatedIds.has(row.id),
    };
  });

  return {
    windowMinutes,
    windowStart,
    windowEnd: now,
    bucketMs,
    historyOmittedCount: omitted,
    historyTruncatedCount: truncatedIds.size,
    workspacesOmitted,
    workspaces,
  };
}
