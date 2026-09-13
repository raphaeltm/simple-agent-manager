/**
 * Types and constants for the placement explorer's teaching model.
 *
 * Split out of `model.ts` so the lifecycle simulation and the ranking arithmetic can each be read
 * on their own (`.claude/rules/18`). The doc comment explaining what this model is — and what it
 * deliberately is not — lives in `model.ts`.
 */
import type { CatalogOffering, ProviderCatalog, Tier } from './catalog';

/** Real default: `DEFAULT_WORKSPACE_ADMISSION_HOST_MEMORY_RESERVE_MB`
 * (apps/api/src/services/workspace-resource-capacity.ts). Memory the host keeps for itself. */
export const HOST_MEMORY_RESERVE_MB = 512;

/** Real default: `PLATFORM_RESOURCE_DEFAULTS.maxCoTenants` (packages/shared). */
export const MAX_CO_TENANTS = 4;

/** Real default: `DEFAULT_MAX_WORKSPACES_PER_NODE`
 * (packages/shared/src/constants/task-execution.ts). A second, node-wide ceiling that
 * `evaluateWorkspaceReservationCapacity` enforces alongside the per-request co-tenant cap. At the
 * defaults it is the STRICTER of the two (3 < 4), so it is the one that actually binds —
 * modelling only the co-tenant cap would let this widget admit a fourth workload that a default
 * deployment refuses. */
export const MAX_WORKSPACES_PER_NODE = 3;

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
  /** Entries retained in the in-memory decision log. */
  eventHistory: 40,
  /** Lifetime of the pool's PRE-EXISTING load. Deliberately much longer than `runSteps`: seeded
   * work represents the fleet's steady-state occupancy, not something that should evaporate a
   * handful of steps into the demo. When it shared `runSteps`, the seeded host freed itself at
   * exactly step 6 — which silently turned "this workload must provision new hardware" into "it
   * landed on the host that just drained", and made a stockout test flaky at that boundary. */
  seededWorkRunSteps: 60,
} as const;

/** How many rows each live list renders. Display truncation only — the model keeps more. */
export const WORKLOAD_DISPLAY_LIMIT = 12;
export const EVENT_DISPLAY_LIMIT = 12;

/** Columns in the strategy-comparison table, shared with the markup so the empty-state `colSpan`
 * cannot drift from the `<th>` count. */
export const COMPARE_COLUMN_COUNT = 7;

/** Loop bound for `simulate()`. A safety valve, not a modelled duration. */
export const DEFAULT_MAX_SIMULATION_STEPS = 60;

export const STRATEGIES = ['pack', 'spread', 'balanced', 'smallest-fit'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** The strategy the explorer opens on. Named so the markup's initial `aria-pressed` and the custom
 * element's initial state cannot disagree, and so reordering `STRATEGIES` cannot silently change
 * which button starts pressed. */
export const DEFAULT_STRATEGY: Strategy = 'balanced';

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
  // NOT "cheapest first". The real default weights are `fit: 1_000_000` against `price: 1`
  // (`DEFAULT_CAPACITY_POOL_SELECTION_SETTINGS`, capacity-pool-placement-settings.ts), so fit
  // dominates the weighted score by six orders of magnitude and price is only ever a tie-break.
  balanced: 'tightest fit first, then cheapest',
  spread: 'tightest fit first, then cheapest',
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
