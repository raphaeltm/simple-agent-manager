/**
 * Active workspace reservation usage on a node: the declared reservations still holding capacity
 * and the running-container memory observations that may be credited against measured use. Split
 * out of `workspace-resource-capacity.ts` (rule 18), which re-exports everything here.
 */
import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';

import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';

export const ACTIVE_WORKSPACE_RESERVATION_STATUSES = ['running', 'creating', 'recovery'] as const;
export const ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL = ACTIVE_WORKSPACE_RESERVATION_STATUSES.map(
  (status) => `'${status}'`
).join(', ');
export const RESOURCE_REQUIREMENTS_SOURCE_SQL =
  "'task', 'trigger', 'skill', 'agent-profile', 'project', 'user', 'platform'";
const D1_BIND_LIMIT = D1_MAX_BOUND_PARAMETERS;

export interface ActiveWorkspaceReservationUsage {
  activeCount: number;
  /**
   * Workspaces still starting on the node (`status = 'creating'`): reserved but not yet
   * dispatched, building, or waiting for the node's single build slot. The node builds one
   * workspace at a time, so this is the startup queue a new placement would join. Only
   * `loadActiveWorkspaceReservationUsage` knows row status; other aggregations report 0.
   */
  startupBacklog: number;
  invalidCount: number;
  exclusiveCount: number;
  cpuMillis: number;
  memoryMb: number;
  /** Fresh running-container usage already included in the node memory reading. */
  observedMemoryCredits?: Array<{ memoryMb: number; collectedAt: number; heartbeatAt: number }>;
  diskMb: number;
}

export function isResolvedResourceReservation(
  value: unknown
): value is ResolvedResourceReservation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.version === 1 || record.version === 2 || record.version === 3) &&
    positiveInteger(record.cpuMillis) !== null &&
    positiveInteger(record.memoryMb) !== null &&
    nonNegativeInteger(record.diskMb) !== null &&
    typeof record.exclusiveNode === 'boolean' &&
    typeof record.source === 'string' &&
    ['task', 'trigger', 'skill', 'agent-profile', 'project', 'user', 'platform'].includes(
      record.source
    )
  );
}

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

export function aggregateWorkspaceReservationRows(
  rows: ReadonlyArray<{ resolvedReservationJson: string | null }>
): ActiveWorkspaceReservationUsage {
  const usage = emptyUsage();
  for (const row of rows) {
    usage.activeCount += 1;
    addReservationUsage(usage, row.resolvedReservationJson);
  }
  return usage;
}

function addReservationUsage(usage: ActiveWorkspaceReservationUsage, value: string | null): void {
  const reservation = parseResolvedResourceReservation(value);
  if (!reservation) {
    usage.invalidCount += 1;
    return;
  }
  usage.cpuMillis += reservation.cpuMillis;
  usage.memoryMb += reservation.memoryMb;
  usage.diskMb += reservation.diskMb;
  if (reservation.exclusiveNode) usage.exclusiveCount += 1;
}

export function emptyUsage(): ActiveWorkspaceReservationUsage {
  return {
    activeCount: 0,
    startupBacklog: 0,
    invalidCount: 0,
    exclusiveCount: 0,
    cpuMillis: 0,
    memoryMb: 0,
    diskMb: 0,
  };
}

export function parseResolvedResourceReservation(
  value: string | null | undefined
): ResolvedResourceReservation | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isResolvedResourceReservation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
