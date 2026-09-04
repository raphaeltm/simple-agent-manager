import type { ResolvedResourceReservation } from '@simple-agent-manager/shared';

export const ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL = "'running', 'creating', 'recovery'";

const RESOURCE_REQUIREMENTS_SOURCES = [
  'task',
  'trigger',
  'skill',
  'agent-profile',
  'project',
  'user',
  'platform',
] as const;

export const RESOURCE_REQUIREMENTS_SOURCE_SQL = RESOURCE_REQUIREMENTS_SOURCES.map(
  (source) => `'${source}'`
).join(', ');

const RESOURCE_REQUIREMENT_SOURCE_SET = new Set<string>(RESOURCE_REQUIREMENTS_SOURCES);

export interface WorkspaceReservationNodeCapacity {
  providerInstanceVcpuCount?: number | null;
  providerInstanceMemoryMb?: number | null;
  providerInstanceDiskGb?: number | null;
}

export interface WorkspaceReservationUsage {
  activeCount: number;
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  hasExclusiveReservation: boolean;
  hasInvalidReservation: boolean;
  minimumMaxCoTenants: number | null;
}

interface ActiveWorkspaceReservationRow {
  nodeId: string;
  resolvedReservationJson: string | null;
}

export function emptyWorkspaceReservationUsage(): WorkspaceReservationUsage {
  return {
    activeCount: 0,
    cpuMillis: 0,
    memoryMb: 0,
    diskMb: 0,
    hasExclusiveReservation: false,
    hasInvalidReservation: false,
    minimumMaxCoTenants: null,
  };
}

export function isResolvedResourceReservation(
  value: unknown
): value is ResolvedResourceReservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    positiveInteger(row['cpuMillis']) !== null &&
    positiveInteger(row['memoryMb']) !== null &&
    positiveInteger(row['diskMb']) !== null &&
    typeof row['exclusiveNode'] === 'boolean' &&
    positiveInteger(row['maxCoTenants']) !== null &&
    typeof row['source'] === 'string' &&
    RESOURCE_REQUIREMENT_SOURCE_SET.has(row['source']) &&
    typeof row['sourceId'] === 'string' &&
    positiveInteger(row['version']) !== null
  );
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

export function aggregateWorkspaceReservationRows(
  rows: ReadonlyArray<{ resolvedReservationJson: string | null }>
): WorkspaceReservationUsage {
  const usage = emptyWorkspaceReservationUsage();
  for (const row of rows) {
    usage.activeCount += 1;
    const reservation = parseResolvedResourceReservation(row.resolvedReservationJson);
    if (!reservation) {
      usage.hasInvalidReservation = true;
      continue;
    }
    usage.cpuMillis += reservation.cpuMillis;
    usage.memoryMb += reservation.memoryMb;
    usage.diskMb += reservation.diskMb;
    usage.hasExclusiveReservation ||= reservation.exclusiveNode;
    usage.minimumMaxCoTenants = Math.min(
      usage.minimumMaxCoTenants ?? reservation.maxCoTenants,
      reservation.maxCoTenants
    );
  }
  return usage;
}

export async function loadActiveWorkspaceReservationUsage(
  database: D1Database,
  nodeIds: readonly string[]
): Promise<Map<string, WorkspaceReservationUsage>> {
  if (nodeIds.length === 0) return new Map();
  const placeholders = nodeIds.map(() => '?').join(',');
  const rows = await database
    .prepare(
      `SELECT node_id AS nodeId, resolved_reservation_json AS resolvedReservationJson
       FROM workspaces
       WHERE node_id IN (${placeholders})
         AND status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})`
    )
    .bind(...nodeIds)
    .all<ActiveWorkspaceReservationRow>();

  const rowsByNode = new Map<string, ActiveWorkspaceReservationRow[]>();
  for (const row of rows.results ?? []) {
    const nodeRows = rowsByNode.get(row.nodeId) ?? [];
    nodeRows.push(row);
    rowsByNode.set(row.nodeId, nodeRows);
  }

  return new Map(
    [...rowsByNode].map(([nodeId, nodeRows]) => [
      nodeId,
      aggregateWorkspaceReservationRows(nodeRows),
    ])
  );
}

/**
 * Advisory reusable-node capacity check. The final INSERT ... SELECT repeats
 * these invariants atomically in workspace-placement.ts.
 *
 * Empty legacy nodes retain one explicit placement path. Once occupied, every
 * active reservation and all provider-native capacity dimensions must be known;
 * unknown data therefore never permits unsafe co-tenancy.
 */
export function hasWorkspaceReservationCapacity(
  node: WorkspaceReservationNodeCapacity,
  usage: WorkspaceReservationUsage,
  request: ResolvedResourceReservation,
  maxWorkspaces: number
): boolean {
  if (!isResolvedResourceReservation(request) || positiveInteger(maxWorkspaces) === null) {
    return false;
  }
  if (usage.activeCount >= maxWorkspaces) return false;
  if (usage.activeCount + 1 > request.maxCoTenants) return false;
  if (usage.minimumMaxCoTenants !== null && usage.activeCount + 1 > usage.minimumMaxCoTenants) {
    return false;
  }
  if (request.exclusiveNode && usage.activeCount > 0) return false;
  if (usage.hasExclusiveReservation) return false;

  const cpuMillis = multiplyPositiveInteger(node.providerInstanceVcpuCount, 1_000);
  const memoryMb = positiveInteger(node.providerInstanceMemoryMb);
  const diskMb = multiplyPositiveInteger(node.providerInstanceDiskGb, 1_024);
  if (usage.activeCount > 0) {
    if (usage.hasInvalidReservation || cpuMillis === null || memoryMb === null || diskMb === null) {
      return false;
    }
    return (
      usage.cpuMillis + request.cpuMillis <= cpuMillis &&
      usage.memoryMb + request.memoryMb <= memoryMb &&
      usage.diskMb + request.diskMb <= diskMb
    );
  }

  return (
    (cpuMillis === null || request.cpuMillis <= cpuMillis) &&
    (memoryMb === null || request.memoryMb <= memoryMb) &&
    (diskMb === null || request.diskMb <= diskMb)
  );
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function multiplyPositiveInteger(value: unknown, multiplier: number): number | null {
  const integer = positiveInteger(value);
  return integer === null ? null : integer * multiplier;
}
