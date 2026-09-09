/**
 * Teaching model for SAM's capacity placement strategies. NOT production scheduling code.
 *
 * It mirrors the shape of the real decision, which is what makes it worth reading:
 *
 *   1. ADMISSION decides whether a host *may* take a workload. In SAM that is
 *      `evaluateWorkspaceReservationCapacity` (apps/api/src/services/workspace-resource-capacity.ts),
 *      the single gate for CPU/memory/disk budgets and the co-tenant cap.
 *   2. RANKING only orders hosts admission already accepted. In SAM that is
 *      `placement-strategy.ts`, whose header states plainly that it "does not re-implement any
 *      hard constraint" and that a ranking change "can never widen admission".
 *
 * Keeping those two steps separate is the whole point. A model that folds them together teaches
 * that a strategy can make something fit, and it cannot.
 *
 * The four ordering keys below are copied verbatim from `PLACEMENT_STRATEGY_HOST_ORDERING`
 * (apps/api/src/services/placement-strategy.ts).
 *
 * ILLUSTRATIVE VALUES, NOT SAM DEFAULTS: boot/run/warm/deadline step counts compress
 * asynchronous work into countable steps so the consequences are visible. `HOST_MEMORY_RESERVE_MB`
 * and `MAX_CO_TENANTS` are the real defaults and are marked as such.
 */
import type { CatalogOffering, ProviderCatalog, Tier } from './catalog';
import { candidatesFor } from './catalog';

/** Real default: `DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB`
 * (apps/api/src/services/workspace-resource-capacity.ts). Memory the host keeps for itself. */
export const HOST_MEMORY_RESERVE_MB = 512;

/** Real default: `PLATFORM_RESOURCE_DEFAULTS.maxCoTenants` (packages/shared). */
export const MAX_CO_TENANTS = 4;

/** Illustrative step counts. Real equivalents are wall-clock and configurable. */
export const LAB = {
  bootSteps: 3,
  runSteps: 6,
  /** Real equivalent: `NODE_WARM_TIMEOUT_MS`, 30 minutes by default. */
  warmSteps: 4,
  /** Real equivalent: the bounded admission wait deadline. */
  queueDeadlineSteps: 10,
  maxNodes: 8,
  maxWorkloads: 24,
} as const;

export const STRATEGIES = ['pack', 'spread', 'balanced', 'smallest-fit'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Verbatim from `PLACEMENT_STRATEGY_HOST_ORDERING`. */
export const HOST_ORDERING: Record<Strategy, string> = {
  pack: 'highest projected utilization first',
  balanced: 'lowest projected utilization first',
  spread: 'fewest co-tenant workspaces first',
  'smallest-fit': 'smallest sufficient host capacity first',
};

/** How each strategy orders brand-new hardware. Mirrors `compareCapacityCandidates`
 * (apps/api/src/services/placement-capacity-ranking.ts). */
export const OFFERING_ORDERING: Record<Strategy, string> = {
  pack: 'largest offering first',
  balanced: 'cheapest offering first',
  spread: 'cheapest offering first',
  'smallest-fit': 'tightest fit first, then cheapest',
};

export const EXHAUSTION_POLICIES = ['fail', 'queue', 'fallback-chain'] as const;
export type ExhaustionPolicy = (typeof EXHAUSTION_POLICIES)[number];

export type WorkloadShape = 'chat' | 'standard' | 'heavy';

export interface WorkloadPreset {
  readonly label: string;
  readonly cpuMillis: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly note: string;
}

/** Reservation shapes taken from real resolved reservations. */
export const WORKLOAD_PRESETS: Record<WorkloadShape, WorkloadPreset> = {
  chat: {
    label: 'Chat',
    cpuMillis: 500,
    memoryMb: 1024,
    diskMb: 4 * 1024,
    note: 'An agent-profile reservation: 0.5 vCPU, 1 GB.',
  },
  standard: {
    label: 'Standard',
    cpuMillis: 2000,
    memoryMb: 4096,
    diskMb: 40 * 1024,
    note: 'The platform default: 2 vCPU, 4 GB. Note it does NOT fit a 4 GB host once the reserve is taken.',
  },
  heavy: {
    label: 'Heavy',
    cpuMillis: 4000,
    memoryMb: 8192,
    diskMb: 80 * 1024,
    note: 'A large build: 4 vCPU, 8 GB.',
  },
};

export type WorkloadState = 'queued' | 'running' | 'done' | 'rejected';

export interface Workload {
  id: number;
  shape: WorkloadShape;
  /** Pre-existing pool work, not something the user submitted. Excluded from outcome counts. */
  seeded?: boolean;
  state: WorkloadState;
  nodeId: number | null;
  remaining: number;
  waited: number;
  reason: string;
}

export type NodeState = 'booting' | 'active' | 'warm' | 'destroyed';

export interface LabNode {
  id: number;
  offering: CatalogOffering;
  region: string;
  state: NodeState;
  bootRemaining: number;
  warmRemaining: number;
  /** Step the node was created on, for stable ordering. */
  createdAt: number;
}

export interface Lab {
  step: number;
  strategy: Strategy;
  policy: ExhaustionPolicy;
  catalog: ProviderCatalog;
  regions: string[];
  /** Regions the provider currently has no stock in — the 412 case. */
  stockedOut: Set<string>;
  nodes: LabNode[];
  workloads: Workload[];
  events: string[];
  nextNodeId: number;
  nextWorkloadId: number;
}

export interface Usage {
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  coTenants: number;
}

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
      } else if (strategy === 'smallest-fit') {
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

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** A pre-existing host in the pool, by catalog tier. Pools accumulate mixed hardware over time —
 * a tier escalation leaves bigger machines alongside smaller ones — and a heterogeneous fleet is
 * the only condition under which all four host-ordering keys are distinguishable. */
export interface SeedHost {
  tier: Tier;
  region: string;
  /** Workloads already running on this host. Occupancy is what separates `pack` (prefers the
   * fullest host) from `smallest-fit` (prefers the smallest); on a completely idle fleet the two
   * coincide, because for a fixed reservation the smallest host is also the highest-utilization
   * one. */
  load?: readonly WorkloadShape[];
}

export interface CreateLabOptions {
  strategy?: Strategy;
  policy?: ExhaustionPolicy;
  seedFleet?: readonly SeedHost[];
  stockedOut?: readonly string[];
}

export function createLab(
  catalog: ProviderCatalog,
  regions: string[],
  options: CreateLabOptions = {}
): Lab {
  const strategy = options.strategy ?? 'balanced';
  const lab: Lab = {
    step: 0,
    strategy,
    policy: options.policy ?? 'queue',
    catalog,
    regions: [...regions],
    stockedOut: new Set(options.stockedOut ?? []),
    nodes: [],
    workloads: [],
    events: [`Ready. ${catalog.label}, ${regions.length} region(s), strategy "${strategy}".`],
    nextNodeId: 1,
    nextWorkloadId: 1,
  };
  for (const host of options.seedFleet ?? []) {
    const offering = catalog.offerings.find((item) => item.tier === host.tier);
    if (!offering) continue;
    const node: LabNode = {
      id: lab.nextNodeId++,
      offering,
      region: host.region,
      state: 'active',
      bootRemaining: 0,
      warmRemaining: 0,
      createdAt: 0,
    };
    lab.nodes.push(node);
    for (const shape of host.load ?? []) {
      lab.workloads.push({
        id: lab.nextWorkloadId++,
        shape,
        state: 'running',
        nodeId: node.id,
        remaining: LAB.runSteps,
        waited: 0,
        reason: `pre-existing work on node ${node.id}`,
        seeded: true,
      });
    }
  }
  return lab;
}

/** Default starting fleet for the explorer: three real, differently-sized hosts, so every
 * host-ordering key has something to order. */
export function defaultSeedFleet(regions: readonly string[]): SeedHost[] {
  const primary = regions[0] ?? 'fsn1';
  const secondary = regions[1] ?? primary;
  return [
    // The big host is genuinely busy and the small host is idle. Without that, `pack` and
    // `smallest-fit` give identical answers: for a fixed reservation the smallest host always
    // has the highest projected utilization, so "fullest" and "smallest" coincide on an idle
    // fleet. A loaded large host is what pulls them apart.
    { tier: 'large', region: primary, load: ['heavy'] },
    { tier: 'medium', region: primary, load: ['chat'] },
    { tier: 'small', region: secondary },
  ];
}

function record(lab: Lab, message: string): void {
  lab.events.unshift(`${String(lab.step).padStart(2, '0')} · ${message}`);
  lab.events = lab.events.slice(0, 40);
}

export function submit(lab: Lab, shape: WorkloadShape): Workload | null {
  if (lab.workloads.length >= LAB.maxWorkloads) return null;
  const workload: Workload = {
    id: lab.nextWorkloadId++,
    shape,
    state: 'queued',
    seeded: false,
    nodeId: null,
    remaining: LAB.runSteps,
    waited: 0,
    reason: 'queued',
  };
  lab.workloads.push(workload);
  record(lab, `${WORKLOAD_PRESETS[shape].label} #${workload.id} queued.`);
  return workload;
}

export function generateBatch(lab: Lab, count = 6): void {
  // Deterministic mix so repeated runs are comparable across strategies.
  const cycle: WorkloadShape[] = ['standard', 'chat', 'standard', 'heavy', 'chat', 'standard'];
  for (let i = 0; i < count; i++) submit(lab, cycle[i % cycle.length] as WorkloadShape);
}

export function setStockout(lab: Lab, region: string, out: boolean): void {
  if (out) lab.stockedOut.add(region);
  else lab.stockedOut.delete(region);
  record(lab, `${region} is ${out ? 'OUT OF STOCK (provider 412)' : 'back in stock'}.`);
}

/** Place one queued workload. Returns true when it started running. */
function place(lab: Lab, workload: Workload): boolean {
  const shape = workload.shape;

  // Step 1 — admission over existing hosts.
  const admitted: LabNode[] = [];
  for (const node of lab.nodes) {
    if (admissionRefusal(lab, node, shape) === null) admitted.push(node);
  }

  // Step 2 — ranking, over the admitted set only.
  if (admitted.length > 0) {
    const target = rankHosts(lab, admitted, shape)[0];
    if (target) {
      const reused = target.state === 'warm';
      target.state = 'active';
      target.warmRemaining = 0;
      workload.state = 'running';
      workload.nodeId = target.id;
      workload.remaining = LAB.runSteps;
      workload.reason = `placed on ${reused ? 'warm ' : ''}node ${target.id} (${target.offering.instanceType} · ${target.region}) — ${HOST_ORDERING[lab.strategy]}`;
      record(
        lab,
        `${WORKLOAD_PRESETS[shape].label} #${workload.id} → ${reused ? 'warm ' : ''}node ${target.id}.`
      );
      return true;
    }
  }

  if (lab.nodes.filter((n) => n.state !== 'destroyed').length >= LAB.maxNodes) {
    workload.reason = 'node ceiling reached';
    return false;
  }

  // The provisioning lease. SAM's VM admission control lets exactly one provision run at a time
  // per credential domain, so a burst does not start N machines at once. Without this the
  // strategies are indistinguishable: every workload would get its own fresh node and never be
  // ranked against an existing one.
  if (lab.nodes.some((node) => node.state === 'booting')) {
    workload.reason = 'waiting — another provision holds the lease';
    return false;
  }

  // Step 3 — no admitted host: provision new hardware.
  const ranked = rankOfferings(lab, shape);
  if (ranked.length === 0) {
    workload.state = 'rejected';
    workload.reason = 'no offering in this pool can hold this reservation';
    record(lab, `${WORKLOAD_PRESETS[shape].label} #${workload.id} rejected: nothing fits.`);
    return false;
  }

  const inStock = ranked.filter((candidate) => !candidate.stockedOut);
  const first = ranked[0];
  if (!first) return false;

  if (first.stockedOut) {
    // The 2026-09-09 incident, exactly: the top-ranked candidate's region has no stock.
    const alternative = inStock[0];
    if (lab.policy === 'fallback-chain' && alternative) {
      const sameDeal =
        alternative.offering.instanceType === first.offering.instanceType &&
        alternative.offering.monthlyCents === first.offering.monthlyCents;
      record(
        lab,
        `${first.offering.instanceType} · ${first.region} returned 412. Falling back to ${alternative.offering.instanceType} · ${alternative.region}${sameDeal ? ' (same machine, same price)' : ''}.`
      );
      return boot(lab, workload, alternative);
    }
    if (lab.policy === 'queue') {
      workload.waited += 1;
      workload.reason = `waiting for capacity in ${first.region} (412) — ${workload.waited}/${LAB.queueDeadlineSteps}`;
      if (workload.waited >= LAB.queueDeadlineSteps) {
        workload.state = 'rejected';
        workload.reason = `capacity wait deadline expired for ${first.offering.instanceType} · ${first.region}`;
        record(lab, `${WORKLOAD_PRESETS[shape].label} #${workload.id} hit the wait deadline.`);
      }
      return false;
    }
    workload.state = 'rejected';
    workload.reason = `provider returned 412 for ${first.offering.instanceType} · ${first.region}; policy "fail" does not try alternatives`;
    record(lab, `${WORKLOAD_PRESETS[shape].label} #${workload.id} failed on a 412.`);
    return false;
  }

  return boot(lab, workload, first);
}

function boot(lab: Lab, workload: Workload, candidate: RankedCandidate): boolean {
  const node: LabNode = {
    id: lab.nextNodeId++,
    offering: candidate.offering,
    region: candidate.region,
    state: 'booting',
    bootRemaining: LAB.bootSteps,
    warmRemaining: 0,
    createdAt: lab.step,
  };
  lab.nodes.push(node);
  workload.reason = `provisioning node ${node.id} (${node.offering.instanceType} · ${node.region}) — ${OFFERING_ORDERING[lab.strategy]}`;
  record(lab, `Provisioning node ${node.id}: ${node.offering.instanceType} in ${node.region}.`);
  return false;
}

export function step(lab: Lab): void {
  lab.step += 1;

  for (const node of lab.nodes) {
    if (node.state === 'booting') {
      node.bootRemaining -= 1;
      if (node.bootRemaining <= 0) {
        node.state = 'active';
        record(lab, `Node ${node.id} is active.`);
      }
    }
  }

  for (const workload of lab.workloads) {
    if (workload.state !== 'running') continue;
    workload.remaining -= 1;
    if (workload.remaining <= 0) {
      workload.state = 'done';
      workload.reason = `finished on node ${workload.nodeId}`;
    }
  }

  for (const workload of lab.workloads) {
    if (workload.state === 'queued') place(lab, workload);
  }

  // Drain: a node with no running workloads goes warm, then is destroyed. The reciprocal
  // admission predicate (rule 69) is re-checked here, not cached — a node that picked up work
  // during the warm window returns to active rather than being torn down under it.
  for (const node of lab.nodes) {
    if (node.state === 'destroyed') continue;
    const busy = usageOf(lab, node.id).coTenants > 0;
    if (node.state === 'active' && !busy) {
      node.state = 'warm';
      node.warmRemaining = LAB.warmSteps;
      record(lab, `Node ${node.id} went warm (reusable for ${LAB.warmSteps} steps).`);
    } else if (node.state === 'warm' && busy) {
      node.state = 'active';
      record(lab, `Node ${node.id} reused while warm.`);
    } else if (node.state === 'warm') {
      node.warmRemaining -= 1;
      if (node.warmRemaining <= 0) {
        node.state = 'destroyed';
        record(lab, `Node ${node.id} destroyed.`);
      }
    }
  }
}

export interface StrategyOutcome {
  strategy: Strategy;
  /** Every host that existed, seeded plus newly provisioned. */
  nodes: number;
  /** Hosts this strategy had to buy. */
  provisioned: number;
  /** Fleet cost, seeded plus provisioned. */
  monthlyCents: number;
  placed: number;
  rejected: number;
  regions: string[];
  /** Which host each workload landed on, in submission order. This is the signal that
   * distinguishes host-ordering keys even when the fleet size comes out the same. */
  placement: string[];
  /** Submitted workloads per host, largest first — the compact shape of the answer. `pack`
   * concentrates (4·1·1), `spread` levels (2·2·2). Fleet size and cost frequently match across
   * strategies, so this is what makes the difference legible at a glance. */
  distribution: number[];
}

/**
 * Run the same workload set to completion under one strategy. Used by the compare view, and by
 * tests to prove the four strategies are observably different rather than merely labelled.
 */
export function simulate(
  catalog: ProviderCatalog,
  regions: string[],
  strategy: Strategy,
  shapes: WorkloadShape[],
  options: {
    policy?: ExhaustionPolicy;
    stockedOut?: readonly string[];
    seedFleet?: readonly SeedHost[];
    maxSteps?: number;
  } = {}
): StrategyOutcome {
  const lab = createLab(catalog, regions, {
    strategy,
    policy: options.policy ?? 'queue',
    stockedOut: options.stockedOut,
    seedFleet: options.seedFleet,
  });
  for (const shape of shapes) submit(lab, shape);

  const maxSteps = options.maxSteps ?? 60;
  for (let i = 0; i < maxSteps; i++) {
    const pending = lab.workloads.some((w) => w.state === 'queued' || w.state === 'running');
    if (!pending) break;
    step(lab);
  }

  const used = lab.nodes;
  const submitted = lab.workloads.filter((w) => !w.seeded);
  const seeded = (options.seedFleet ?? []).length;
  const label = (id: number | null): string => {
    const node = used.find((candidate) => candidate.id === id);
    return node ? `${node.offering.instanceType}@${node.region}#${node.id}` : '-';
  };
  return {
    strategy,
    nodes: used.length,
    provisioned: Math.max(0, used.length - seeded),
    monthlyCents: used.reduce((total, node) => total + node.offering.monthlyCents, 0),
    placed: submitted.filter((w) => w.state === 'done' || w.state === 'running').length,
    rejected: submitted.filter((w) => w.state === 'rejected').length,
    regions: [...new Set(used.map((node) => node.region))].sort(),
    placement: submitted.map((w) => label(w.nodeId)),
    distribution: [
      ...submitted
        .filter((w) => w.nodeId !== null)
        .reduce((counts, w) => {
          const key = w.nodeId as number;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return counts;
        }, new Map<number, number>())
        .values(),
    ].sort((a, b) => b - a),
  };
}
