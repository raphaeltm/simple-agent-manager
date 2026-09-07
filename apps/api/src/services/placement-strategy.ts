/**
 * Strategy-aware placement ranking, shared by reusable-host selection
 * (TaskRunner `node-selection.ts`) and fresh provider-offering selection
 * (`placement-resolver-capacity.ts`).
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It does not re-implement any hard constraint.
 * `evaluateWorkspaceReservationCapacity` (services/workspace-resource-capacity.ts)
 * remains the single admission gate for finite CPU/memory/storage budgets,
 * exclusivity, the co-tenant safety cap, the disk-pressure veto, and the
 * fail-closed handling of untrusted/stale capacity. This module only ORDERS
 * hosts that gate has already admitted, so a ranking change can never widen
 * admission. See `.claude/rules/24` and `.claude/rules/59`.
 *
 * WHY THE STRATEGY KEY IS LEXICOGRAPHIC, NOT WEIGHTED
 * ---------------------------------------------------
 * Each strategy's defining signal is compared FIRST and on its own. The
 * configurable `selectionWeights` only tune the secondary blend. Folding the
 * defining signal into the weighted score would let a weight configuration
 * collapse two strategies into each other — which is exactly the pre-existing
 * defect this module fixes (`balanced` and `spread` shared one weighted score
 * and were byte-identical). A strategy the operator selected must remain
 * observable regardless of how the weights are tuned.
 *
 * NORMALIZED UNITS (normalized exactly once, here)
 * -----------------------------------------------
 * CPU  -> milli-vCPU of admission budget (`cpuBudgetMillis`)
 * RAM  -> MiB of assignable memory after the host reserve (`usableMemoryMb`)
 * DISK -> MiB of reservable storage
 * Load -> the existing weighted CPU/memory pressure score (0..100)
 */
import type {
  CapacityPoolPlacementSettings,
  CapacityPoolStrategy,
} from '@simple-agent-manager/shared';

import {
  type ActiveWorkspaceReservationUsage,
  cpuBudgetMillis,
  emptyUsage,
  parseWorkspaceAdmissionMetrics,
  resolveTrustedWorkspaceNodeCapacity,
  scoreWorkspaceAdmissionMetrics,
  usableMemoryMb,
  type WorkspaceAdmissionMetrics,
  type WorkspaceAdmissionPolicy,
  type WorkspaceResourceNode,
} from './workspace-resource-capacity';

/** Ordering key that defines each strategy, surfaced in placement diagnostics. */
export const PLACEMENT_STRATEGY_HOST_ORDERING: Record<CapacityPoolStrategy, string> = {
  pack: 'highest projected utilization first',
  balanced: 'lowest projected utilization first',
  spread: 'fewest co-tenant workspaces first',
  'smallest-fit': 'smallest sufficient host capacity first',
};

/**
 * A host's placement signals, normalized once so every strategy compares the
 * same units. `null` capacity means the host has no trusted observed hardware —
 * such a host is already rejected by admission, and ranks last here so a
 * ranking-only caller cannot promote it.
 */
export interface PlacementHostSignals {
  nodeId: string;
  cpuMillisCapacity: number | null;
  cpuMillisCommitted: number;
  memoryMbCapacity: number | null;
  memoryMbCommitted: number;
  diskMbCapacity: number | null;
  diskMbCommitted: number;
  /** Active workspaces already placed on the host. */
  coTenantCount: number;
  /**
   * Dominant-resource utilization in [0, 1] AFTER placing the pending request,
   * or null when no dimension has trusted capacity.
   */
  projectedUtilization: number | null;
  /** Live weighted CPU/memory pressure (0..100), or null without fresh telemetry. */
  observedLoadScore: number | null;
  capacitySource: 'observed' | 'planned' | null;
  locationKey: string;
}

/** The pending reservation, in the same normalized units as the host signals. */
export interface PlacementRequestUnits {
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
}

export interface NormalizePlacementHostSignalsInput {
  node: WorkspaceResourceNode & {
    id: string;
    cloudProvider?: string | null;
    vmLocation?: string | null;
  };
  usage: ActiveWorkspaceReservationUsage | undefined;
  request: PlacementRequestUnits;
  policy: WorkspaceAdmissionPolicy;
  metrics?: WorkspaceAdmissionMetrics | null;
}

/** Stable key identifying the provider/location a host or offering occupies. */
export function placementLocationKey(
  provider: string | null | undefined,
  location: string | null | undefined
): string {
  return `${provider ?? 'unknown'}:${location ?? 'unknown'}`;
}

export function normalizePlacementHostSignals(
  input: NormalizePlacementHostSignalsInput
): PlacementHostSignals {
  const { node, request, policy } = input;
  const usage = input.usage ?? emptyUsage();
  const metrics =
    input.metrics === undefined ? parseWorkspaceAdmissionMetrics(node, policy) : input.metrics;
  const trusted = resolveTrustedWorkspaceNodeCapacity(node);

  const cpuMillisCapacity =
    trusted.vcpuCount === null ? null : cpuBudgetMillis(trusted.vcpuCount, policy);
  const memoryMbCapacity =
    trusted.memoryMb === null ? null : usableMemoryMb(trusted.memoryMb, policy);
  const diskMbCapacity = trusted.diskGb === null ? null : trusted.diskGb * 1024;

  return {
    nodeId: node.id,
    cpuMillisCapacity,
    cpuMillisCommitted: usage.cpuMillis,
    memoryMbCapacity,
    memoryMbCommitted: usage.memoryMb,
    diskMbCapacity,
    diskMbCommitted: usage.diskMb,
    coTenantCount: usage.activeCount,
    projectedUtilization: projectedDominantUtilization(
      { cpuMillisCapacity, memoryMbCapacity, diskMbCapacity },
      usage,
      request
    ),
    observedLoadScore: scoreWorkspaceAdmissionMetrics(metrics, policy),
    capacitySource: trusted.source,
    locationKey: placementLocationKey(node.cloudProvider, node.vmLocation),
  };
}

/**
 * Order two admitted hosts for `strategy`. Lower sorts first.
 *
 * The comparison is a total order: every branch ends in the shared tie-break
 * chain, which terminates on `nodeId`. Ranking must be reproducible across
 * identical calls (`.claude/rules/65`).
 */
export function comparePlacementHostsByStrategy(
  a: PlacementHostSignals,
  b: PlacementHostSignals,
  strategy: CapacityPoolStrategy,
  settings?: CapacityPoolPlacementSettings
): number {
  // A host without trusted capacity cannot be ranked on any resource signal.
  // Admission already rejects it; ordering it last keeps a ranking-only caller
  // from promoting it if that gate is ever bypassed.
  const trustDiff = trustRank(a) - trustRank(b);
  if (trustDiff !== 0) return trustDiff;

  const defining = compareStrategyDefiningKey(a, b, strategy);
  if (defining !== 0) return defining;

  return compareHostTieBreak(a, b, strategy, settings);
}

/**
 * The one signal that defines each strategy. Compared before any weighted term
 * so a weight configuration can never make two strategies agree.
 */
function compareStrategyDefiningKey(
  a: PlacementHostSignals,
  b: PlacementHostSignals,
  strategy: CapacityPoolStrategy
): number {
  switch (strategy) {
    case 'pack': {
      // Fill the fullest host that still fits, so fewer hosts stay occupied.
      return compareNullableDesc(a.projectedUtilization, b.projectedUtilization);
    }
    case 'spread': {
      // Maximize isolation: fewest neighbours wins, independent of how large
      // or how loaded the host is. This is what separates spread from balanced.
      if (a.coTenantCount !== b.coTenantCount) return a.coTenantCount - b.coTenantCount;
      return 0;
    }
    case 'smallest-fit': {
      // Reserve the big hosts for work that needs them: take the smallest host
      // whose capacity still satisfies the request.
      return compareTotalCapacityAsc(a, b);
    }
    case 'balanced':
    default: {
      // Even out load: lowest utilization relative to the host's own size.
      return compareNullableAsc(a.projectedUtilization, b.projectedUtilization);
    }
  }
}

/**
 * Secondary ordering. `selectionWeights` tune this blend only — see the module
 * header for why they must not reach the defining key.
 */
function compareHostTieBreak(
  a: PlacementHostSignals,
  b: PlacementHostSignals,
  strategy: CapacityPoolStrategy,
  settings?: CapacityPoolPlacementSettings
): number {
  const weighted =
    weightedHostScore(a, strategy, settings) - weightedHostScore(b, strategy, settings);
  if (weighted !== 0) return weighted;

  const loadDiff = compareNullableAsc(a.observedLoadScore, b.observedLoadScore);
  if (loadDiff !== 0) return loadDiff;

  if (a.coTenantCount !== b.coTenantCount) return a.coTenantCount - b.coTenantCount;
  return a.nodeId.localeCompare(b.nodeId);
}

function weightedHostScore(
  signals: PlacementHostSignals,
  strategy: CapacityPoolStrategy,
  settings?: CapacityPoolPlacementSettings
): number {
  const weights = settings?.selectionWeights;
  const capacityWeight = boundedWeight(weights?.capacity);
  const fitWeight = boundedWeight(weights?.fit);
  const utilization = signals.projectedUtilization ?? 1;
  // `pack` wants high utilization, every other strategy wants low.
  const utilizationTerm = strategy === 'pack' ? 1 - utilization : utilization;
  const residual = 1 - utilization;
  const score = utilizationTerm * capacityWeight + residual * fitWeight;
  return Number.isFinite(score) ? score : Number.MAX_SAFE_INTEGER;
}

/**
 * Inventory of how many of the caller's live hosts already occupy each
 * provider/location. Lets fresh-offering ranking honour `pack` and `spread`,
 * which are otherwise unobservable before a host exists.
 */
export interface PlacementLocationInventory {
  countFor(provider: string | null | undefined, location: string | null | undefined): number;
  readonly totalHosts: number;
}

export function buildPlacementLocationInventory(
  hosts: ReadonlyArray<{ cloudProvider?: string | null; vmLocation?: string | null }>
): PlacementLocationInventory {
  const counts = new Map<string, number>();
  for (const host of hosts) {
    const key = placementLocationKey(host.cloudProvider, host.vmLocation);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    countFor(provider, location) {
      return counts.get(placementLocationKey(provider, location)) ?? 0;
    },
    totalHosts: hosts.length,
  };
}

/**
 * Location ordering for a fresh offering under `strategy`, or 0 when the
 * strategy does not care about host distribution. `pack` concentrates onto
 * locations that already host work; `spread` moves away from them.
 */
export function comparePlacementLocationsByStrategy(
  a: { provider: string | null; location: string | null },
  b: { provider: string | null; location: string | null },
  strategy: CapacityPoolStrategy,
  inventory: PlacementLocationInventory | undefined
): number {
  if (!inventory) return 0;
  if (strategy !== 'pack' && strategy !== 'spread') return 0;
  const aCount = inventory.countFor(a.provider, a.location);
  const bCount = inventory.countFor(b.provider, b.location);
  if (aCount === bCount) return 0;
  return strategy === 'pack' ? bCount - aCount : aCount - bCount;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function trustRank(signals: PlacementHostSignals): number {
  return signals.capacitySource === null ? 1 : 0;
}

function projectedDominantUtilization(
  capacity: {
    cpuMillisCapacity: number | null;
    memoryMbCapacity: number | null;
    diskMbCapacity: number | null;
  },
  usage: ActiveWorkspaceReservationUsage,
  request: PlacementRequestUnits
): number | null {
  const ratios: number[] = [];
  pushRatio(ratios, capacity.cpuMillisCapacity, usage.cpuMillis + request.cpuMillis);
  pushRatio(ratios, capacity.memoryMbCapacity, usage.memoryMb + request.memoryMb);
  pushRatio(ratios, capacity.diskMbCapacity, usage.diskMb + request.diskMb);
  if (ratios.length === 0) return null;
  // Dominant-resource utilization: a host is as full as its fullest dimension.
  return Math.max(...ratios);
}

function pushRatio(target: number[], capacity: number | null, committed: number): void {
  if (capacity === null) return;
  // A zero-capacity dimension is saturated by definition; admission rejects it,
  // and 1 keeps it ranked as full rather than producing a non-finite ratio.
  target.push(capacity <= 0 ? 1 : committed / capacity);
}

function compareTotalCapacityAsc(a: PlacementHostSignals, b: PlacementHostSignals): number {
  const cpu = compareNullableAsc(a.cpuMillisCapacity, b.cpuMillisCapacity);
  if (cpu !== 0) return cpu;
  const memory = compareNullableAsc(a.memoryMbCapacity, b.memoryMbCapacity);
  if (memory !== 0) return memory;
  return compareNullableAsc(a.diskMbCapacity, b.diskMbCapacity);
}

/** Ascending, with `null` (unknown) always last so it never wins a comparison. */
function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** Descending, with `null` (unknown) always last so it never wins a comparison. */
function compareNullableDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function boundedWeight(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}
