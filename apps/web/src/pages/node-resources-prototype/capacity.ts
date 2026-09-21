import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

import {
  CPU_SHARE_BUDGET_PERCENT,
  HOST_MEMORY_RESERVE_MB,
  type MeasuredUsage,
  MOCK_MEASURED,
  STANDARD_RESERVATION,
} from './mock-data';
import type { DimensionKey } from './viz-tokens';

/**
 * Capacity derivation mirrors the scheduler, so the prototype cannot show a
 * number the placement code would disagree with:
 *
 *   cpuBudgetMillis()  = vcpu * 1000 * cpuShareBudgetPercent / 100
 *   usableMemoryMb()   = memoryMb - hostMemoryReserveMb   (512 MB)
 *   disk budget        = diskGb * 1024
 *
 * See apps/api/src/services/workspace-resource-capacity.ts.
 */

export interface Reservation {
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  exclusiveNode: boolean;
}

export interface Tenant {
  workspace: WorkspaceResponse;
  /** Stable 0-based position on this node; drives both segment order and ramp step. */
  index: number;
  label: string;
  reservation: Reservation | null;
  measured: MeasuredUsage | null;
}

export interface DimensionCapacity {
  key: DimensionKey;
  /** Schedulable capacity in the dimension's native unit (millicores / MB / MB). */
  capacity: number | null;
  /** Hardware total before the host reserve is subtracted (memory only differs). */
  hardwareTotal: number | null;
  /** Sum of every tenant reservation. */
  reserved: number;
  /** Sum of measured mean usage across tenants that have telemetry. */
  measuredMean: number | null;
  /**
   * Number of tenants whose OWN measured peak exceeded their OWN reservation.
   * Per-tenant peaks are NOT summed into a node-level peak: they do not co-occur,
   * so the sum is not a quantity the machine ever reached (iteration 2 rendered
   * "peak 14.8 vCPU" on an 8-vCPU host that way).
   */
  burstTenants: number;
  /** The node's own observed utilisation percent from `lastMetrics`, if reported. */
  hostPercent: number | null;
  /** Reserved as a percentage of capacity; null when capacity is unknown. */
  reservedPercent: number | null;
  /** Measured mean as a percentage of capacity. */
  measuredPercent: number | null;
  /** Tenants missing telemetry for this dimension. */
  untrackedTenants: number;
}

export interface NodeCapacity {
  node: NodeResponse;
  tenants: Tenant[];
  dimensions: Record<DimensionKey, DimensionCapacity>;
  /** Highest reservedPercent across dimensions; null when capacity is unknown. */
  bindingPercent: number | null;
  /** Which dimension is closest to full — the one that will refuse the next tenant. */
  bindingKey: DimensionKey | null;
  /** True when the hardware is not yet reported (node still provisioning). */
  capacityUnknown: boolean;
  /** Whether any tenant asked for the whole host. */
  exclusive: boolean;
  /** Memory withheld for the host itself, in MB. Always shown, never hidden. */
  hostReserveMb: number;
}

function parseReservation(raw: string | null | undefined): Reservation | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const cpuMillis = Number(record.cpuMillis);
    const memoryMb = Number(record.memoryMb);
    const diskMb = Number(record.diskMb);
    if (![cpuMillis, memoryMb, diskMb].every((n) => Number.isFinite(n) && n >= 0)) return null;
    return { cpuMillis, memoryMb, diskMb, exclusiveNode: record.exclusiveNode === true };
  } catch {
    return null;
  }
}

function dimensionValue(reservation: Reservation, key: DimensionKey): number {
  if (key === 'cpu') return reservation.cpuMillis;
  if (key === 'memory') return reservation.memoryMb;
  return reservation.diskMb;
}

export function tenantReservationFor(tenant: Tenant, key: DimensionKey): number {
  return tenant.reservation ? dimensionValue(tenant.reservation, key) : 0;
}

export function tenantMeasuredFor(
  tenant: Tenant,
  key: DimensionKey,
  stat: 'mean' | 'peak'
): number | null {
  const m = tenant.measured;
  if (!m) return null;
  if (key === 'cpu') return stat === 'mean' ? m.cpuMeanMillis : m.cpuPeakMillis;
  if (key === 'memory') {
    const bytes = stat === 'mean' ? m.memoryMeanBytes : m.memoryPeakBytes;
    return bytes === null ? null : bytes / (1024 * 1024);
  }
  // Disk has no mean/peak distinction in the collector — it is a level, not a rate.
  return m.diskUsedMb;
}

function capacityFor(node: NodeResponse, key: DimensionKey): { capacity: number | null; hardwareTotal: number | null } {
  if (key === 'cpu') {
    const vcpu = node.observedProviderInstanceVcpuCount ?? node.providerInstanceVcpuCount ?? null;
    if (vcpu === null) return { capacity: null, hardwareTotal: null };
    return {
      capacity: Math.floor((vcpu * 1000 * CPU_SHARE_BUDGET_PERCENT) / 100),
      hardwareTotal: vcpu * 1000,
    };
  }
  if (key === 'memory') {
    const mb = node.observedProviderInstanceMemoryMb ?? node.providerInstanceMemoryMb ?? null;
    if (mb === null) return { capacity: null, hardwareTotal: null };
    return { capacity: Math.max(0, mb - HOST_MEMORY_RESERVE_MB), hardwareTotal: mb };
  }
  const gb = node.observedProviderInstanceDiskGb ?? node.providerInstanceDiskGb ?? null;
  if (gb === null) return { capacity: null, hardwareTotal: null };
  return { capacity: gb * 1024, hardwareTotal: gb * 1024 };
}

const DIMENSION_KEYS: DimensionKey[] = ['cpu', 'memory', 'disk'];

/**
 * The node's own reading of itself, as a percent. These are the same fields the
 * production MiniMetricBadge renders, and unlike a sum of tenant peaks they are a
 * real measurement of the whole machine.
 */
function hostPercentFor(node: NodeResponse, key: DimensionKey): number | null {
  const metrics = node.lastMetrics;
  if (!metrics) return null;
  const raw =
    key === 'cpu' ? metrics.cpuLoadAvg1 : key === 'memory' ? metrics.memoryPercent : metrics.diskPercent;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export function buildNodeCapacity(
  node: NodeResponse,
  workspaces: WorkspaceResponse[]
): NodeCapacity {
  const tenants: Tenant[] = workspaces.map((ws, index) => ({
    workspace: ws,
    index,
    label: ws.displayName || ws.name,
    reservation: parseReservation(ws.resolvedReservationJson),
    measured: MOCK_MEASURED[ws.id] ?? null,
  }));

  const dimensions = {} as Record<DimensionKey, DimensionCapacity>;
  for (const key of DIMENSION_KEYS) {
    const { capacity, hardwareTotal } = capacityFor(node, key);
    let reserved = 0;
    let measuredMean = 0;
    let burstTenants = 0;
    let tracked = 0;
    for (const tenant of tenants) {
      const tenantReserved = tenantReservationFor(tenant, key);
      reserved += tenantReserved;
      const mean = tenantMeasuredFor(tenant, key, 'mean');
      const peak = tenantMeasuredFor(tenant, key, 'peak');
      if (mean !== null) {
        measuredMean += mean;
        tracked += 1;
      }
      if (peak !== null && tenantReserved > 0 && peak > tenantReserved) burstTenants += 1;
    }
    dimensions[key] = {
      key,
      capacity,
      hardwareTotal,
      reserved,
      measuredMean: tracked > 0 ? measuredMean : null,
      burstTenants,
      hostPercent: hostPercentFor(node, key),
      reservedPercent: capacity && capacity > 0 ? (reserved / capacity) * 100 : null,
      measuredPercent:
        capacity && capacity > 0 && tracked > 0 ? (measuredMean / capacity) * 100 : null,
      untrackedTenants: tenants.length - tracked,
    };
  }

  let bindingKey: DimensionKey | null = null;
  let bindingPercent: number | null = null;
  for (const key of DIMENSION_KEYS) {
    const percent = dimensions[key].reservedPercent;
    if (percent === null) continue;
    if (bindingPercent === null || percent > bindingPercent) {
      bindingPercent = percent;
      bindingKey = key;
    }
  }

  return {
    node,
    tenants,
    dimensions,
    bindingKey,
    bindingPercent,
    capacityUnknown: DIMENSION_KEYS.every((key) => dimensions[key].capacity === null),
    exclusive: tenants.some((t) => t.reservation?.exclusiveNode === true),
    hostReserveMb: HOST_MEMORY_RESERVE_MB,
  };
}

/**
 * How many more tenants of the median size on this node would still fit, and
 * which dimension runs out first. Falls back to the platform default reservation
 * when the node is empty, so a warm node still answers "what fits here?".
 */
export function headroomSlots(capacity: NodeCapacity): {
  slots: number | null;
  bindingKey: DimensionKey | null;
  yardstick: Reservation;
  yardstickIsDefault: boolean;
} {
  const reservations = capacity.tenants
    .map((t) => t.reservation)
    .filter((r): r is Reservation => r !== null);
  const yardstickIsDefault = reservations.length === 0;
  const yardstick: Reservation = yardstickIsDefault
    ? { ...STANDARD_RESERVATION, exclusiveNode: false }
    : {
        cpuMillis: median(reservations.map((r) => r.cpuMillis)),
        memoryMb: median(reservations.map((r) => r.memoryMb)),
        diskMb: median(reservations.map((r) => r.diskMb)),
        exclusiveNode: false,
      };

  if (capacity.capacityUnknown) {
    return { slots: null, bindingKey: null, yardstick, yardstickIsDefault };
  }
  // An exclusive tenant refuses co-tenants regardless of arithmetic headroom.
  if (capacity.exclusive) {
    return { slots: 0, bindingKey: capacity.bindingKey, yardstick, yardstickIsDefault };
  }

  let slots: number | null = null;
  let bindingKey: DimensionKey | null = null;
  let bindingShare = -1;
  for (const key of DIMENSION_KEYS) {
    const dim = capacity.dimensions[key];
    const unit = dimensionValue(yardstick, key);
    if (dim.capacity === null || unit <= 0) continue;
    const fits = Math.max(0, Math.floor((dim.capacity - dim.reserved) / unit));
    const share = dim.reservedPercent ?? 0;
    // Ties on slot count (very common once a node is full — every dimension reports
    // zero) break by the highest reserved share, so this agrees with the binding
    // dimension the capacity rails name for the same node. Two cards on one page
    // must not contradict each other about the same machine.
    const better = slots === null || fits < slots || (fits === slots && share > bindingShare);
    if (better) {
      slots = fits;
      bindingKey = key;
      bindingShare = share;
    }
  }
  return { slots, bindingKey, yardstick, yardstickIsDefault };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1] ?? upper;
  return Math.round((lower + upper) / 2);
}
