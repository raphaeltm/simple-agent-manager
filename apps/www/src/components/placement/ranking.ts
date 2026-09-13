/**
 * Capacity arithmetic, the admission gate, and strategy ranking.
 *
 * The separation between the two halves of this file is the point of the whole exercise:
 * `admissionRefusal` decides whether a host MAY take a workload, and the `rank*` functions only
 * order hosts it already accepted. See the module doc in `model.ts`.
 */
import type { CatalogOffering } from './catalog';
import { candidatesFor } from './catalog';
import type { Lab, LabNode, Usage, WorkloadShape } from './types';
import {
  HOST_MEMORY_RESERVE_MB,
  MAX_CO_TENANTS,
  MAX_WORKSPACES_PER_NODE,
  WORKLOAD_PRESETS,
} from './types';

// ---------------------------------------------------------------------------
// Capacity arithmetic
// ---------------------------------------------------------------------------

export function cpuBudgetMillis(node: LabNode): number {
  return node.offering.vcpu * 1000;
}

/** Assignable memory after the host keeps its reserve. This is the line that disqualifies a
 * 4 GB host from a 4 GB workload. Single source: both the admission gate and the
 * provision-time offering filter must subtract the reserve the SAME way, or hardware gets
 * bought that the final reservation check then refuses. */
export function usableMemoryForOffering(offering: CatalogOffering): number {
  return Math.max(0, offering.memoryMb - HOST_MEMORY_RESERVE_MB);
}

export function usableMemoryMb(node: LabNode): number {
  return usableMemoryForOffering(node.offering);
}

export function usageOf(lab: Lab, nodeId: number): Usage {
  const usage: Usage = { cpuMillis: 0, memoryMb: 0, diskMb: 0, coTenants: 0 };
  for (const workload of lab.workloads) {
    if (workload.nodeId !== nodeId || workload.state !== 'running') continue;
    const preset = WORKLOAD_PRESETS[workload.shape];
    usage.cpuMillis += preset.cpuMillis;
    usage.memoryMb += preset.memoryMb;
    usage.diskMb += preset.diskMb;
    usage.coTenants += 1;
  }
  return usage;
}

/**
 * THE ADMISSION GATE. Ranking never changes this answer.
 * Returns null when the host may take the workload, or a human-readable refusal.
 */
export function admissionRefusal(lab: Lab, node: LabNode, shape: WorkloadShape): string | null {
  // A warm node is reusable — that is the entire point of the warm pool. Only booting and
  // destroyed hosts are unavailable.
  if (node.state !== 'active' && node.state !== 'warm') return `node is ${node.state}`;
  const preset = WORKLOAD_PRESETS[shape];
  const usage = usageOf(lab, node.id);
  // Both ceilings are real and both are checked; at the defaults the node-wide one is stricter.
  if (usage.coTenants >= MAX_WORKSPACES_PER_NODE) {
    return `node workspace cap (${MAX_WORKSPACES_PER_NODE}) reached`;
  }
  if (usage.coTenants >= MAX_CO_TENANTS) return `co-tenant cap (${MAX_CO_TENANTS}) reached`;
  if (usage.cpuMillis + preset.cpuMillis > cpuBudgetMillis(node)) return 'not enough vCPU';
  if (usage.memoryMb + preset.memoryMb > usableMemoryMb(node)) {
    return `not enough memory after the ${HOST_MEMORY_RESERVE_MB} MB host reserve`;
  }
  if (usage.diskMb + preset.diskMb > node.offering.diskMb) return 'not enough disk';
  return null;
}

/** Dominant-resource utilization: a host is as full as its fullest dimension. */
export function projectedUtilization(lab: Lab, node: LabNode, shape: WorkloadShape): number {
  const preset = WORKLOAD_PRESETS[shape];
  const usage = usageOf(lab, node.id);
  const ratios = [
    (usage.cpuMillis + preset.cpuMillis) / Math.max(1, cpuBudgetMillis(node)),
    (usage.memoryMb + preset.memoryMb) / Math.max(1, usableMemoryMb(node)),
    (usage.diskMb + preset.diskMb) / Math.max(1, node.offering.diskMb),
  ];
  return Math.max(...ratios);
}

/** Total normalized capacity, used by `smallest-fit` and `pack` offering ordering. */
function offeringSize(item: CatalogOffering): number {
  return item.vcpu * 1000 + item.memoryMb;
}

function hostSize(node: LabNode): number {
  return node.offering.vcpu * 1000 + usableMemoryMb(node);
}

// ---------------------------------------------------------------------------
// Ranking — orders only what admission already accepted
// ---------------------------------------------------------------------------

/**
 * Order admitted hosts by the strategy's DEFINING key, lexicographically, then break ties to a
 * total order so repeated runs are byte-identical (rule 65).
 */
export function rankHosts(lab: Lab, hosts: LabNode[], shape: WorkloadShape): LabNode[] {
  const strategy = lab.strategy;
  return [...hosts].sort((a, b) => {
    let primary = 0;
    if (strategy === 'pack') {
      primary = projectedUtilization(lab, b, shape) - projectedUtilization(lab, a, shape);
    } else if (strategy === 'balanced') {
      primary = projectedUtilization(lab, a, shape) - projectedUtilization(lab, b, shape);
    } else if (strategy === 'spread') {
      primary = usageOf(lab, a.id).coTenants - usageOf(lab, b.id).coTenants;
    } else {
      primary = hostSize(a) - hostSize(b);
    }
    if (Math.abs(primary) > 1e-9) return primary;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id - b.id;
  });
}

export interface RankedCandidate {
  offering: CatalogOffering;
  region: string;
  /** True when this candidate is only excluded because its region is out of stock. */
  stockedOut: boolean;
}

/**
 * Order brand-new hardware. Region is NOT a ranking input except for `pack`/`spread`, which
 * cluster or scatter by how many nodes already live in each region — mirroring
 * `comparePlacementLocationsByStrategy`, which returns 0 for every other strategy.
 *
 * That no-op is the point of the whole exercise: two regions offering the same machine at the
 * same price are a genuine tie, so nothing prefers the one that happens to be out of stock.
 */
export function rankOfferings(lab: Lab, shape: WorkloadShape): RankedCandidate[] {
  const preset = WORKLOAD_PRESETS[shape];
  const strategy = lab.strategy;
  const nodesPerRegion = new Map<string, number>();
  for (const node of lab.nodes) {
    if (node.state === 'destroyed') continue;
    nodesPerRegion.set(node.region, (nodesPerRegion.get(node.region) ?? 0) + 1);
  }

  const viable = candidatesFor(lab.catalog, lab.regions).filter(({ offering: item }) => {
    // Admission arithmetic applied to hardware that does not exist yet: provision only what
    // could pass the final reservation check. Mirrors the host-reserve filter in
    // `normalizeCapacityCandidate` (placement-resolver-capacity.ts).
    if (item.vcpu * 1000 < preset.cpuMillis) return false;
    if (usableMemoryForOffering(item) < preset.memoryMb) return false;
    if (item.diskMb < preset.diskMb) return false;
    return true;
  });

  return viable
    .map(({ offering: item, region }) => ({
      offering: item,
      region,
      stockedOut: lab.stockedOut.has(region),
    }))
    .sort((a, b) => {
      if (strategy === 'pack' || strategy === 'spread') {
        const aCount = nodesPerRegion.get(a.region) ?? 0;
        const bCount = nodesPerRegion.get(b.region) ?? 0;
        const byRegion = strategy === 'pack' ? bCount - aCount : aCount - bCount;
        if (byRegion !== 0) return byRegion;
      }
      if (strategy === 'pack') {
        const bySize = offeringSize(b.offering) - offeringSize(a.offering);
        if (bySize !== 0) return bySize;
      } else {
        // Fit surplus leads for `smallest-fit` explicitly, and for `balanced`/`spread` through the
        // weighted score, whose real default weights are `fit: 1_000_000` against `price: 1`. Six
        // orders of magnitude means fit dominates; price is only a tie-break.
        const surplusA = offeringSize(a.offering) - (preset.cpuMillis + preset.memoryMb);
        const surplusB = offeringSize(b.offering) - (preset.cpuMillis + preset.memoryMb);
        if (surplusA !== surplusB) return surplusA - surplusB;
      }
      const byPrice = a.offering.monthlyCents - b.offering.monthlyCents;
      if (byPrice !== 0) return byPrice;
      if (strategy !== 'pack') {
        const bySize = offeringSize(a.offering) - offeringSize(b.offering);
        if (bySize !== 0) return bySize;
      }
      // Total order. Region sorts LAST and only as a determinism tiebreak — never as a preference.
      return (
        a.offering.instanceType.localeCompare(b.offering.instanceType) ||
        a.region.localeCompare(b.region)
      );
    });
}
