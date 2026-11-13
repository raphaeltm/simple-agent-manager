/**
 * Declared workspace reservation usage on a node, and the parsers that read persisted
 * reservation snapshots. Pure: the worker's D1 loader fills the usage shape.
 */
import type {
  ResolvedResourceReservation,
  ResourceRequirementsSource,
} from '@simple-agent-manager/shared';

/**
 * Reservation sources a persisted snapshot may carry. The single list behind both the advisory
 * parser below and the worker's final-admission SQL (`RESOURCE_REQUIREMENTS_SOURCE_SQL`), so the
 * two can never accept different sources.
 */
export const RESOURCE_REQUIREMENTS_SOURCES = [
  'task',
  'trigger',
  'skill',
  'agent-profile',
  'project',
  'user',
  'platform',
] as const satisfies readonly ResourceRequirementsSource[];

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
    (RESOURCE_REQUIREMENTS_SOURCES as readonly string[]).includes(record.source)
  );
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

export function addReservationUsage(usage: ActiveWorkspaceReservationUsage, value: string | null): void {
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
