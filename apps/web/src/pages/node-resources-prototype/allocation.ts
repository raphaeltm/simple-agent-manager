// PROTOTYPE — design exploration only. Never ships to production.
// Mirrors the API's declared-reservation accounting so the concepts show honest numbers:
//   allocatable CPU  = vCPU × 1000 × cpuShareBudgetPercent (default 100)
//   allocatable RAM  = memoryMb − hostMemoryReserveMb (default 512)
//   allocatable disk = diskGb × 1024
// See apps/api/src/services/workspace-resource-capacity.ts (cpuBudgetMillis / usableMemoryMb).
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

export const HOST_MEMORY_RESERVE_MB = 512;
export const CPU_SHARE_BUDGET_PERCENT = 100;
/** Matches MAX_VISIBLE_WORKSPACES in the real NodeCard: rows beyond this fold into "+N more". */
export const MAX_IDENTITY_SEGMENTS = 3;

export type ResourceKey = 'cpu' | 'memory' | 'disk';
export const RESOURCE_KEYS: ResourceKey[] = ['cpu', 'memory', 'disk'];
export const RESOURCE_LABELS: Record<ResourceKey, string> = {
  cpu: 'vCPU',
  memory: 'RAM',
  disk: 'Disk',
};

/** cpu in millicores, memory and disk in MB. */
export type ResourceTriple = Record<ResourceKey, number>;

export interface AllocationSegment {
  workspaceId: string;
  label: string;
  branch?: string;
  status: WorkspaceResponse['status'];
  /** 0..2 = identity hue, 3 = folded "other" bucket. */
  colorIndex: number;
  /** Number of workspaces folded into this segment (1 unless it is the "other" bucket). */
  count: number;
  amounts: ResourceTriple;
}

export interface NodeAllocation {
  /** Allocatable capacity after host reserve; null when the node has no hardware record. */
  capacity: ResourceTriple | null;
  segments: AllocationSegment[];
  reserved: ResourceTriple;
  /** Reservations SAM could not read (no resolvedReservationJson). */
  unknownReservationCount: number;
  /** Live telemetry as a fraction (0..1+) of allocatable capacity; null when absent. */
  live: Record<ResourceKey, number | null>;
}

/**
 * Identity hues for the first three workspace rows. Validated with the dataviz palette
 * checker on both the dark (#13201d) and light (#f8fbf8) card surfaces: all checks pass
 * (worst adjacent CVD ΔE 15.9, normal-vision ΔE 26.4).
 */
export const SEGMENT_COLORS = ['var(--sam-color-accent-primary)', '#3987e5', '#d55181'] as const;
export const OTHER_SEGMENT_COLOR = 'var(--sam-color-fg-muted)';

export function segmentColor(index: number): string {
  return SEGMENT_COLORS[index] ?? OTHER_SEGMENT_COLOR;
}

/** Severity for single-hue meters (rails, glyph). Thresholds match MiniMetricBadge (60 / 85). */
export function severityColor(fraction: number): string {
  if (fraction >= 0.85) return 'var(--sam-color-danger)';
  if (fraction >= 0.6) return 'var(--sam-color-warning)';
  return 'var(--sam-color-accent-primary)';
}

function readReservation(workspace: WorkspaceResponse): ResourceTriple | null {
  if (!workspace.resolvedReservationJson) return null;
  try {
    const parsed: unknown = JSON.parse(workspace.resolvedReservationJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return { cpu: num(r.cpuMillis), memory: num(r.memoryMb), disk: num(r.diskMb) };
  } catch {
    return null;
  }
}

function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function computeAllocation(
  node: NodeResponse,
  workspaces: WorkspaceResponse[]
): NodeAllocation {
  const vcpu = positive(node.observedProviderInstanceVcpuCount ?? node.providerInstanceVcpuCount);
  const memoryMb = positive(node.observedProviderInstanceMemoryMb ?? node.providerInstanceMemoryMb);
  const diskGb = positive(node.observedProviderInstanceDiskGb ?? node.providerInstanceDiskGb);

  const capacity: ResourceTriple | null =
    vcpu && memoryMb && diskGb
      ? {
          cpu: Math.floor((vcpu * 1000 * CPU_SHARE_BUDGET_PERCENT) / 100),
          memory: Math.max(0, memoryMb - HOST_MEMORY_RESERVE_MB),
          disk: diskGb * 1024,
        }
      : null;

  const segments: AllocationSegment[] = [];
  let unknownReservationCount = 0;
  const other: AllocationSegment = {
    workspaceId: '__other__',
    label: 'Other workspaces',
    status: 'running',
    colorIndex: MAX_IDENTITY_SEGMENTS,
    count: 0,
    amounts: { cpu: 0, memory: 0, disk: 0 },
  };

  workspaces.forEach((workspace, index) => {
    const amounts = readReservation(workspace);
    if (!amounts) {
      unknownReservationCount += 1;
      return;
    }
    if (index < MAX_IDENTITY_SEGMENTS) {
      segments.push({
        workspaceId: workspace.id,
        label: workspace.displayName || workspace.name,
        branch: workspace.branch,
        status: workspace.status,
        colorIndex: index,
        count: 1,
        amounts,
      });
    } else {
      other.count += 1;
      for (const key of RESOURCE_KEYS) other.amounts[key] += amounts[key];
    }
  });
  if (other.count > 0) {
    other.label = `+${other.count} more`;
    segments.push(other);
  }

  const reserved: ResourceTriple = { cpu: 0, memory: 0, disk: 0 };
  for (const segment of segments) {
    for (const key of RESOURCE_KEYS) reserved[key] += segment.amounts[key];
  }

  const metrics = node.lastMetrics;
  const live: NodeAllocation['live'] = {
    cpu:
      metrics?.cpuLoadAvg1 != null && capacity ? (metrics.cpuLoadAvg1 * 1000) / capacity.cpu : null,
    memory:
      metrics?.memoryPercent != null && capacity && memoryMb
        ? ((metrics.memoryPercent / 100) * memoryMb) / capacity.memory
        : null,
    disk: metrics?.diskPercent != null ? metrics.diskPercent / 100 : null,
  };

  return { capacity, segments, reserved, unknownReservationCount, live };
}

export function remainingOf(allocation: NodeAllocation, key: ResourceKey): number | null {
  if (!allocation.capacity) return null;
  return Math.max(0, allocation.capacity[key] - allocation.reserved[key]);
}

export function overCommitOf(allocation: NodeAllocation, key: ResourceKey): number {
  if (!allocation.capacity) return 0;
  return Math.max(0, allocation.reserved[key] - allocation.capacity[key]);
}

export function fillFraction(allocation: NodeAllocation, key: ResourceKey): number | null {
  if (!allocation.capacity || allocation.capacity[key] <= 0) return null;
  return allocation.reserved[key] / allocation.capacity[key];
}

/** "2", "0.5", "7" — cpu millicores as vCPU count. */
export function formatCpu(millis: number): string {
  return String(Number((millis / 1000).toFixed(1)));
}

/** "4 GB", "3.5 GB", "0.5 GB" — MB as GB with at most one decimal. */
export function formatGb(mb: number): string {
  return `${Number((mb / 1024).toFixed(1))} GB`;
}

/** Number only, in the resource's display unit: "2" (vCPU) or "4" / "3.5" (GB). Pair with unitOf(). */
export function formatAmount(key: ResourceKey, value: number): string {
  return key === 'cpu' ? formatCpu(value) : String(Number((value / 1024).toFixed(1)));
}

/** "2 vCPU" / "3.5 GB". */
export function formatWithUnit(key: ResourceKey, value: number): string {
  return `${formatAmount(key, value)} ${unitOf(key)}`;
}

/** Short unit suffix for headline numbers: "vCPU" / "GB". */
export function unitOf(key: ResourceKey): string {
  return key === 'cpu' ? 'vCPU' : 'GB';
}

export function headlineNumber(key: ResourceKey, value: number): string {
  return formatAmount(key, value);
}

export function summarizeReservation(amounts: ResourceTriple): string {
  return `${formatCpu(amounts.cpu)} vCPU · ${formatGb(amounts.memory)} · ${formatGb(amounts.disk)} disk`;
}
