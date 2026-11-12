/**
 * D1 side of active workspace reservation usage: the SQL constants of the admission statements
 * and the loader that reads declared reservations and running-container memory observations for
 * a set of nodes. The usage shape and its parsers are pure and live in `scheduler-core`.
 */
import {
  type ActiveWorkspaceReservationUsage,
  addReservationUsage,
  emptyUsage,
  parseResolvedResourceReservation,
  parseTimestampMs,
} from '@simple-agent-manager/scheduler-core';

import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';

export const ACTIVE_WORKSPACE_RESERVATION_STATUSES = ['running', 'creating', 'recovery'] as const;
export const ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL = ACTIVE_WORKSPACE_RESERVATION_STATUSES.map(
  (status) => `'${status}'`
).join(', ');
export const RESOURCE_REQUIREMENTS_SOURCE_SQL =
  "'task', 'trigger', 'skill', 'agent-profile', 'project', 'user', 'platform'";
const D1_BIND_LIMIT = D1_MAX_BOUND_PARAMETERS;

export async function loadActiveWorkspaceReservationUsage(
  database: D1Database,
  nodeIds: readonly string[]
): Promise<Map<string, ActiveWorkspaceReservationUsage>> {
  const usage = new Map<string, ActiveWorkspaceReservationUsage>();
  const uniqueNodeIds = Array.from(new Set(nodeIds)).filter((id) => id.length > 0);

  for (let i = 0; i < uniqueNodeIds.length; i += D1_BIND_LIMIT) {
    const chunk = uniqueNodeIds.slice(i, i + D1_BIND_LIMIT);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await database
      .prepare(
        `SELECT w.node_id AS nodeId, w.resolved_reservation_json AS reservationJson,
           w.id AS workspaceId, w.status, w.updated_at AS updatedAt,
           n.last_metrics AS lastMetrics, n.last_heartbeat_at AS lastHeartbeatAt
         FROM workspaces w JOIN nodes n ON n.id = w.node_id
         WHERE w.node_id IN (${placeholders})
           AND w.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})`
      )
      .bind(...chunk)
      .all<{
        nodeId: string;
        reservationJson: string | null;
        workspaceId: string;
        status: string;
        updatedAt: string;
        lastMetrics: string | null;
        lastHeartbeatAt: string | null;
      }>();

    for (const row of rows.results ?? []) {
      const existing = usage.get(row.nodeId) ?? emptyUsage();
      existing.activeCount += 1;
      if (row.status === 'creating') existing.startupBacklog += 1;
      addReservationUsage(existing, row.reservationJson);
      const credit = observedWorkspaceMemoryCredit(row);
      if (credit) {
        existing.observedMemoryCredits ??= [];
        existing.observedMemoryCredits.push(credit);
      }
      usage.set(row.nodeId, existing);
    }
  }

  return usage;
}

/** Credit only a unique running-container observation from this lifecycle and heartbeat.
 * Missing/invalid observations leave the complete reservation outstanding. */
function observedWorkspaceMemoryCredit(row: {
  workspaceId: string;
  status: string;
  updatedAt: string;
  reservationJson: string | null;
  lastMetrics: string | null;
  lastHeartbeatAt: string | null;
}): { memoryMb: number; collectedAt: number; heartbeatAt: number } | null {
  const reservation = parseResolvedResourceReservation(row.reservationJson);
  if (!reservation || row.status !== 'running' || !row.lastMetrics) return null;
  const heartbeat = parseTimestampMs(row.lastHeartbeatAt);
  const updated = parseTimestampMs(row.updatedAt);
  if (heartbeat === null || updated === null) return null;
  try {
    const metrics = JSON.parse(row.lastMetrics);
    if (!Array.isArray(metrics?.workspaceMemory)) return null;
    const matches = metrics.workspaceMemory.filter(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === 'object' &&
        (entry as Record<string, unknown>).workspaceId === row.workspaceId
    );
    if (matches.length !== 1) return null;
    const metric = matches[0];
    const collected =
      typeof metric.collectedAt === 'string' ? parseTimestampMs(metric.collectedAt) : null;
    // Reject samples from a predecessor lifecycle or a future heartbeat.
    if (collected === null || collected < updated || collected > heartbeat) return null;
    if (
      typeof metric.memoryUsageBytes !== 'number' ||
      !Number.isFinite(metric.memoryUsageBytes) ||
      metric.memoryUsageBytes < 0
    )
      return null;
    return {
      memoryMb: Math.min(reservation.memoryMb, metric.memoryUsageBytes / (1024 * 1024)),
      collectedAt: collected,
      heartbeatAt: heartbeat,
    };
  } catch {
    return null;
  }
}

