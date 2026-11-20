/**
 * Admin "Health & cost" (Insights slice H, idea 01M7HTS38KX2G78JD0ESAGMKKH): one aggregated,
 * superadmin-only read of this installation's compute spend, machine reuse and packing,
 * lifecycle latency against its budgets, and why new machines were created.
 *
 * Everything is derived at read time from the records SAM already keeps; nothing here is stored.
 * Costs are estimates at the provider list price recorded on each node.
 */

export const INSTALLATION_HEALTH_RANGES = ['7d', '30d', 'month'] as const;
export type InstallationHealthRange = (typeof INSTALLATION_HEALTH_RANGES)[number];
export const DEFAULT_INSTALLATION_HEALTH_RANGE: InstallationHealthRange = 'month';

export function isInstallationHealthRange(value: unknown): value is InstallationHealthRange {
  return (INSTALLATION_HEALTH_RANGES as readonly unknown[]).includes(value);
}

/** Sections of the read. A section that fails is null and named in `unavailable`. */
export type InstallationHealthSection =
  'compute' | 'reuse' | 'density' | 'newMachines' | 'latency' | 'cloudflare';

export interface InstallationHealthWindow {
  range: InstallationHealthRange;
  /** Inclusive start (ISO). */
  start: string;
  /** Exclusive end (ISO): the time of the read. */
  end: string;
}

export interface InstallationComputeProviderSpend {
  provider: string;
  /** In the enclosing currency. */
  amount: number;
  nodeHours: number;
  /** Priced machines of this provider that ran during the range. */
  nodes: number;
}

export interface InstallationComputeWeek {
  /** Monday 00:00 UTC that starts the week (ISO). */
  weekStart: string;
  /** In the enclosing currency. */
  total: number;
  byProvider: { provider: string; amount: number }[];
}

/** Spend of the machines priced in one currency. */
export interface InstallationComputeCurrencySpend {
  /** ISO 4217 code of the recorded prices, e.g. `EUR` for Hetzner, `USD` for GCP. */
  currency: string;
  total: number;
  byProvider: InstallationComputeProviderSpend[];
  /** Trailing weeks, oldest first, the current (partial) week last. */
  weeks: InstallationComputeWeek[];
}

/**
 * Machine lifetime × the machine's recorded hourly price, summed per machine. Workspaces share
 * machines, so a machine is counted once however many workspaces ran on it. Providers record
 * prices in their own currency and nothing converts between them, so spend is reported per
 * currency and never added across currencies.
 */
export interface InstallationComputeSpend {
  /** One entry per price currency that ran in the range or its weeks, most machines first. */
  currencies: InstallationComputeCurrencySpend[];
  /** Machines that ran during the range with no readable hourly price; they add nothing. */
  unpricedNodes: number;
  /** Managed cloud machines that ran during the range. */
  nodes: number;
  /** True when the machine read hit its cap; totals are then a lower bound. */
  truncated: boolean;
}

/**
 * Placements of a workspace on a machine. A placement is on an existing machine when an earlier
 * workspace exists on that machine or a warm-pool claim on it preceded the placement, and on a new
 * machine otherwise.
 */
export interface InstallationMachineReuse {
  placements: number;
  onExistingMachine: number;
  onNewMachine: number;
  /**
   * Placements on an existing machine that came from the warm pool: an unreleased warm-pool claim
   * in the node decision log on that machine since its previous workspace. Always a part of
   * `onExistingMachine`; null when the decision log could not be read.
   */
  fromWarmPool: number | null;
  /** onExistingMachine / placements, 0-1; null with no placements. */
  reuseRate: number | null;
  weeks: { weekStart: string; placements: number; reuseRate: number | null }[];
  truncated: boolean;
}

/**
 * Agents running at once on a machine, averaged over the time the machine had at least one
 * agent running. Running time comes from resource telemetry (first to last sample while the
 * workspace ran), not from the creation-to-deletion compute ledger, which also counts stopped
 * workspaces that were not deleted yet.
 */
export interface InstallationMachineDensity {
  agentsPerBusyMachine: number | null;
  busyMachineHours: number;
  agentHours: number;
  peakAgentsOnOneMachine: number;
  /** Machines with at least one running interval in the range. */
  machines: number;
  /** Running intervals read. */
  runs: number;
  truncated: boolean;
}

export type InstallationNewMachineReasonKind = 'refused' | 'no_candidate' | 'not_recorded';

/**
 * One condition that sent a placement to a new machine. `refused` reasons are the capacity
 * gate's own words for why an existing machine was turned down; a new machine is counted once
 * under each distinct reason it recorded.
 */
export interface InstallationNewMachineReason {
  reason: string;
  kind: InstallationNewMachineReasonKind;
  machines: number;
}

export interface InstallationNewMachineReasons {
  newMachines: number;
  /** Most common first, capped by the `insights.healthMaxReasons` admin setting. */
  reasons: InstallationNewMachineReason[];
  /** Distinct reasons left out by that cap. */
  otherReasons: number;
}

/** Open incident states; `watching` is a defect triage chose to measure rather than fix now. */
export type InstallationLatencyIncidentState = 'pending' | 'dispatched' | 'claimed' | 'watching';

/** An open platform-feedback incident raised by the lifecycle latency watchdog or daily check. */
export interface InstallationLatencyIncident {
  signature: string;
  state: InstallationLatencyIncidentState;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  /** Idea tracking the incident, when one was filed, and the project it lives in. */
  ideaId: string | null;
  ideaProjectId: string | null;
}

export interface InstallationLatencyState {
  entityType: string;
  status: string;
  budgetMs: number;
  /** Finished episodes in the range (lower-bound durations from five-minute samples). */
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** True when the per-state sample limit cut off older episodes in the range. */
  truncated: boolean;
  /** Enough samples and p95 above budget (the daily check's `over_budget`). */
  overBudget: boolean;
  /** Rows in this state right now for longer than its budget. */
  overBudgetNow: number;
  incidents: InstallationLatencyIncident[];
}

export interface InstallationLifecycleLatency {
  minSamples: number;
  states: InstallationLatencyState[];
}

export interface InstallationHealthResponse {
  window: InstallationHealthWindow;
  generatedAt: string;
  compute: InstallationComputeSpend | null;
  reuse: InstallationMachineReuse | null;
  density: InstallationMachineDensity | null;
  newMachines: InstallationNewMachineReasons | null;
  latency: InstallationLifecycleLatency | null;
  /** The Cloudflare account's estimated cost, in USD. Never added to `compute`. */
  cloudflare: InstallationCloudflareCost | null;
  unavailable: InstallationHealthSection[];
}

/**
 * State of the daily Cloudflare cost snapshot (Insights slice CF):
 * - `never_run`: no snapshot has been attempted yet (it runs daily at 03:00 UTC);
 * - `not_configured`: `CF_API_TOKEN` or `CF_ACCOUNT_ID` is not set on the Worker;
 * - `permission_denied`: the token cannot read account analytics (Account Analytics: Read);
 * - `error`: the last attempt failed for another reason; earlier days still show;
 * - `ok`: the last attempt stored its window.
 */
export type InstallationCloudflareCostStatus =
  'never_run' | 'not_configured' | 'permission_denied' | 'error' | 'ok';

/** `POST /api/admin/health-cost/cloudflare/refresh`: the snapshot run's own outcome. */
export interface InstallationCloudflareRefreshResponse {
  status: Exclude<InstallationCloudflareCostStatus, 'never_run'>;
  /** The window stored by a successful run. */
  firstDay: string | null;
  lastDay: string | null;
  rowsWritten: number;
  error: string | null;
}

export interface InstallationCloudflareProductLine {
  /** Billed metric key, e.g. `doDurationGbSeconds`. */
  key: string;
  product: string;
  label: string;
  unit: string;
  monthToDateUsage: number;
  monthToDateUsd: number;
  projectedUsd: number;
}

/**
 * Usage-derived estimate of what the Cloudflare account costs, from billed analytics at
 * Cloudflare's list prices (`.claude/rules/76`). Not an invoice: it covers the whole account
 * (every Worker on it), excludes the Workers Paid subscription, and leaves a few products
 * unpriced. The month is the month of the latest stored day.
 */
export interface InstallationCloudflareCost {
  status: InstallationCloudflareCostStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  /** Why the last attempt failed, as Cloudflare or the Worker reported it. */
  error: string | null;
  /** `YYYY-MM` of the latest stored day; null with no stored days. */
  month: string | null;
  /** Latest stored day (`YYYY-MM-DD`). */
  throughDay: string | null;
  /** True when `throughDay` is the month's last day: the projection is the month's total. */
  monthComplete: boolean;
  /** Days from the 1st through `throughDay` with no stored row; they count as zero. */
  missingDays: number;
  monthToDateUsd: number;
  /** Spent so far plus the recent daily rate for the rest of the month. */
  projectedUsd: number;
  /** Most projected cost first, capped by `insights.healthCloudflareTopLines`. */
  productLines: InstallationCloudflareProductLine[];
  /** Product lines left out by that cap, and their summed costs. */
  otherProductLines: { count: number; monthToDateUsd: number; projectedUsd: number };
  /** Daily estimated cost, oldest first, ending at `throughDay`. Days with no rows are null. */
  daily: { day: string; costUsd: number | null }[];
}
