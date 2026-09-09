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
import type { ProviderCatalog } from './catalog';
import { admissionRefusal, rankHosts, rankOfferings, usageOf } from './ranking';
import type { RankedCandidate } from './ranking';
import type {
  CreateLabOptions,
  ExhaustionPolicy,
  Lab,
  LabNode,
  SeedHost,
  Strategy,
  Workload,
  WorkloadShape,
} from './types';
import {
  DEFAULT_MAX_SIMULATION_STEPS,
  DEFAULT_STRATEGY,
  HOST_ORDERING,
  LAB,
  OFFERING_ORDERING,
  WORKLOAD_PRESETS,
} from './types';

// Re-exported so every consumer keeps importing the model from one place.
export * from './types';
export {
  admissionRefusal,
  cpuBudgetMillis,
  projectedUtilization,
  rankHosts,
  rankOfferings,
  usableMemoryForOffering,
  usableMemoryMb,
  usageOf,
} from './ranking';
export type { RankedCandidate } from './ranking';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------



export function createLab(
  catalog: ProviderCatalog,
  regions: string[],
  options: CreateLabOptions = {}
): Lab {
  const strategy = options.strategy ?? DEFAULT_STRATEGY;
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
        remaining: LAB.seededWorkRunSteps,
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
  lab.events = lab.events.slice(0, LAB.eventHistory);
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

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_SIMULATION_STEPS;
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
    // Explicit comparator: bare `.sort()` orders by UTF-16 code unit, not locale.
    regions: [...new Set(used.map((node) => node.region))].sort((a, b) => a.localeCompare(b)),
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
