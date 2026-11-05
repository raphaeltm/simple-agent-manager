/**
 * `ops_list_nodes` and `ops_get_node`: every node in the installation, across users.
 *
 * Health is derived with the same function the node UI uses (`deriveNodeHealth`), so a node
 * reads the same here as on its page. Lists disclose their total (`.claude/rules/65`).
 */
import type { Env } from '../../env';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { neutralizeUntrustedText } from '../../operations/untrusted-text';
import { deriveNodeHealth } from '../node-health';
import { getStatus as getNodeLifecycleStatus } from '../node-lifecycle';
import { listNodeLogCaptures } from '../node-log-capture-read';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from '../workspace-resource-capacity';

type Row = Record<string, unknown>;

const NODE_FIELDS = `n.id, n.user_id, n.name, n.status, n.health_status, n.cloud_provider,
  n.vm_size, n.vm_location, n.node_role, n.node_class, n.runtime, n.provider_instance_id,
  n.last_heartbeat_at, n.heartbeat_stale_after_seconds, n.agent_ready_at, n.agent_version,
  n.last_metrics, n.warm_since, n.cleanup_backoff_until, n.cleanup_blocked_since,
  n.cleanup_blocked_reason, n.offboarding_status, n.error_message, n.created_at, n.updated_at`;

function parseJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return maybeJsonRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

/**
 * Node names, heartbeat metrics, placement explanations and incident text come from users and
 * node processes: strip control characters and envelope-marker lines from every string.
 */
function neutralizeStrings<T>(value: T): T {
  if (typeof value === 'string') return neutralizeUntrustedText(value) as T;
  if (Array.isArray(value)) return value.map((item) => neutralizeStrings(item) as unknown) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, neutralizeStrings(item)])
    ) as T;
  }
  return value;
}

function shapeNode(row: Row, now: number) {
  const createdAt = String(row.created_at ?? '');
  const createdMs = Date.parse(
    createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`
  );
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    status: row.status,
    health: deriveNodeHealth(
      {
        status: String(row.status),
        healthStatus: typeof row.health_status === 'string' ? row.health_status : 'stale',
        lastHeartbeatAt: typeof row.last_heartbeat_at === 'string' ? row.last_heartbeat_at : null,
        createdAt,
        heartbeatStaleAfterSeconds: Number(row.heartbeat_stale_after_seconds) || 0,
      },
      now
    ),
    storedHealthStatus: row.health_status,
    provider: row.cloud_provider,
    providerInstanceId: row.provider_instance_id,
    vmSize: row.vm_size,
    location: row.vm_location,
    role: row.node_role,
    nodeClass: row.node_class,
    runtime: row.runtime,
    lastHeartbeatAt: row.last_heartbeat_at,
    agentReadyAt: row.agent_ready_at,
    agentVersion: row.agent_version,
    lastMetrics: parseJson(row.last_metrics),
    warmSince: row.warm_since,
    ageMinutes: Number.isFinite(createdMs) ? Math.round((now - createdMs) / 60_000) : null,
    cleanup: {
      backoffUntil: row.cleanup_backoff_until,
      blockedSince: row.cleanup_blocked_since,
      blockedReason: row.cleanup_blocked_reason,
      offboardingStatus: row.offboarding_status,
    },
    hasErrorMessage: typeof row.error_message === 'string' && row.error_message.length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeWorkspaces:
      row.active_workspaces === undefined ? undefined : Number(row.active_workspaces),
    workspaces: row.workspace_count === undefined ? undefined : Number(row.workspace_count),
  };
}

export interface ListNodesFilter {
  readonly status?: string | null;
  readonly userId?: string | null;
  readonly includeDeleted?: boolean;
  readonly limit: number;
}

/** Newest first; a status/user filter narrows the set before the cap. */
export async function listFleetNodes(env: Env, filter: ListNodesFilter, now = Date.now()) {
  const rows = await env.DATABASE.prepare(
    `SELECT ${NODE_FIELDS},
       (SELECT COUNT(*) FROM workspaces w
         WHERE w.node_id = n.id AND w.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})) AS active_workspaces,
       (SELECT COUNT(*) FROM workspaces w
         WHERE w.node_id = n.id AND w.status != 'deleted') AS workspace_count,
       COUNT(*) OVER () AS total
     FROM nodes n
     WHERE (? = 1 OR n.status != 'deleted')
       AND (? IS NULL OR n.status = ?)
       AND (? IS NULL OR n.user_id = ?)
     ORDER BY julianday(n.created_at) DESC, n.id ASC
     LIMIT ?`
  )
    .bind(
      filter.includeDeleted ? 1 : 0,
      filter.status ?? null,
      filter.status ?? null,
      filter.userId ?? null,
      filter.userId ?? null,
      filter.limit
    )
    .all<Row>();
  const results = rows.results ?? [];
  const total = results.length > 0 ? Number(results[0]?.total) : 0;
  return {
    total,
    returned: results.length,
    truncated: total > results.length,
    nodes: results.map((row) => neutralizeStrings(shapeNode(row, now))),
  };
}

/** One node with its workspaces, lifecycle DO state, placement, health episodes and incidents. */
export async function getFleetNode(env: Env, nodeId: string, limit: number, now = Date.now()) {
  const node = await env.DATABASE.prepare(
    `SELECT ${NODE_FIELDS}, n.placement_explanation_json FROM nodes n WHERE n.id = ?`
  )
    .bind(nodeId)
    .first<Row>();
  if (!node) return null;

  const [workspaces, healthEvents, incidents, lifecycle, logCaptures] = await Promise.all([
    env.DATABASE.prepare(
      `SELECT id, project_id, user_id, chat_session_id, status, last_activity_at, dispatched_at,
              created_at, updated_at, COUNT(*) OVER () AS total
       FROM workspaces WHERE node_id = ?
       ORDER BY CASE WHEN status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL}) THEN 0 ELSE 1 END,
         julianday(updated_at) DESC, id ASC
       LIMIT ?`
    )
      .bind(nodeId, limit)
      .all<Row>(),
    env.DATABASE.prepare(
      `SELECT episode_started_at, event, reason, created_at, COUNT(*) OVER () AS total
       FROM node_health_events WHERE node_id = ?
       ORDER BY julianday(created_at) DESC, rowid DESC
       LIMIT ?`
    )
      .bind(nodeId, limit)
      .all<Row>(),
    env.DATABASE.prepare(
      `SELECT id, platform_error_id, workspace_id, signature, status, occurrence_count,
              last_seen_at, artifact_count, total_bytes, failure_reason, created_at,
              COUNT(*) OVER () AS total
       FROM diagnostic_incidents WHERE node_id = ?
       ORDER BY julianday(COALESCE(last_seen_at, created_at)) DESC, id ASC
       LIMIT ?`
    )
      .bind(nodeId, limit)
      .all<Row>(),
    getNodeLifecycleStatus(env, nodeId).then(
      (state) => ({ state }),
      (error: unknown) => ({
        error: neutralizeUntrustedText(error instanceof Error ? error.message : String(error)),
      })
    ),
    // Black box captures survive the node; read one with ops_get_node_log_capture.
    listNodeLogCaptures(env.DATABASE, nodeId, limit).then(
      (items) => ({ items }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
    ),
  ]);

  const listed = (result: { results?: Row[] }) => {
    const items = result.results ?? [];
    const total = items.length > 0 ? Number(items[0]?.total) : 0;
    return {
      total,
      truncated: total > items.length,
      items: items.map(({ total: _total, ...rest }) => rest),
    };
  };

  return neutralizeStrings({
    node: shapeNode(node, now),
    placementExplanation: parseJson(node.placement_explanation_json),
    lifecycle,
    workspaces: listed(workspaces),
    healthEvents: listed(healthEvents),
    diagnosticIncidents: listed(incidents),
    logCaptures,
  });
}
