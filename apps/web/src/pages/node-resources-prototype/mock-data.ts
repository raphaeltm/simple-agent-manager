import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

/**
 * Fixtures use the real wire shapes: `NodeResponse` for hosts,
 * `WorkspaceResponse` for tenants (with `resolvedReservationJson` serialised the
 * way the API stores it), and the `WorkspaceResourceSummary` fields shipped by
 * PR #2110 for measured usage.
 *
 * The headline fixture reproduces the 2026-09-20 production shape: one cx53
 * (16 vCPU / 32768 MB) holding five workspaces and one cx43 (8 vCPU / 16384 MB)
 * holding one. The remaining nodes stress the layout: near-zero, near-saturation,
 * a single exclusive tenant, and an unknown-capacity node with hostile labels.
 */

/** Mirrors `usableMemoryMb()` in apps/api/src/services/workspace-resource-capacity.ts. */
export const HOST_MEMORY_RESERVE_MB = 512;

/** Mirrors `cpuBudgetMillis()` — the default CPU share budget is 100%. */
export const CPU_SHARE_BUDGET_PERCENT = 100;

/** Platform default reservation, used as the "standard tenant" yardstick. */
export const STANDARD_RESERVATION = { cpuMillis: 400, memoryMb: 820, diskMb: 2048 };

interface Reservation {
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  exclusiveNode?: boolean;
  source?: string;
}

/** Measured usage, shaped like the `WorkspaceResourceSummary` rows from PR #2110. */
export interface MeasuredUsage {
  cpuMeanMillis: number | null;
  cpuPeakMillis: number | null;
  memoryMeanBytes: number | null;
  memoryPeakBytes: number | null;
  diskUsedMb: number | null;
  oomCount: number;
  sampleCount: number;
}

const MB = 1024 * 1024;

function reservation(r: Reservation): string {
  return JSON.stringify({
    cpuMillis: r.cpuMillis,
    memoryMb: r.memoryMb,
    diskMb: r.diskMb,
    exclusiveNode: r.exclusiveNode ?? false,
    source: r.source ?? 'agent-profile',
    sourceId: '01KTS0KEQ3BETA4JE82X207792',
    version: 3,
  });
}

function node(partial: Partial<NodeResponse> & Pick<NodeResponse, 'id' | 'name'>): NodeResponse {
  return {
    status: 'running',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    ipAddress: '10.0.0.2',
    lastHeartbeatAt: '2026-09-20T18:41:02Z',
    lastMetrics: null,
    errorMessage: null,
    createdAt: '2026-09-20T11:04:00Z',
    updatedAt: '2026-09-20T18:41:02Z',
    ...partial,
  } as NodeResponse;
}

function workspace(
  partial: Partial<WorkspaceResponse> & Pick<WorkspaceResponse, 'id' | 'name' | 'nodeId'>
): WorkspaceResponse {
  return {
    projectId: '01KHRJGANBBWGDY1NZ0KVF0D4J',
    repository: 'raphaeltm/simple-agent-manager',
    branch: 'main',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    vmIp: null,
    lastActivityAt: '2026-09-20T18:39:11Z',
    errorMessage: null,
    createdAt: '2026-09-20T11:22:00Z',
    updatedAt: '2026-09-20T18:39:11Z',
    ...partial,
  } as WorkspaceResponse;
}

// ── Node 1 — the production shape: cx53, 16 vCPU / 32 GB / 360 GB, 5 tenants ──

export const NODE_CX53 = node({
  id: '01M2ZQ7X4K3N8V6T1B9D5F2G7H',
  name: 'sam-node-20260920110400',
  providerInstanceType: 'cx53',
  providerInstanceVcpuCount: 16,
  providerInstanceMemoryMb: 32768,
  providerInstanceDiskGb: 360,
  providerInstanceArchitecture: 'x86_64',
  observedProviderInstanceType: 'cx53',
  observedProviderInstanceVcpuCount: 16,
  observedProviderInstanceMemoryMb: 32768,
  observedProviderInstanceDiskGb: 360,
  providerInstancePriceDisplay: '€49.90/mo',
  vmSize: 'large',
  lastMetrics: { cpuLoadAvg1: 31.4, memoryPercent: 41.2, diskPercent: 12.8 },
});

// ── Node 2 — cx43, one tenant, deliberately hostile labels ───────────────────

export const NODE_CX43 = node({
  id: '01M2ZQ8B7P1R4S9W2X6Y3Z5A8C',
  name: 'sam-node-20260920080312',
  providerInstanceType: 'cx43',
  providerInstanceVcpuCount: 8,
  providerInstanceMemoryMb: 16384,
  providerInstanceDiskGb: 160,
  observedProviderInstanceType: 'cx43',
  observedProviderInstanceVcpuCount: 8,
  observedProviderInstanceMemoryMb: 16384,
  observedProviderInstanceDiskGb: 160,
  providerInstancePriceDisplay: '€24.90/mo',
  vmLocation: 'nbg1',
  lastMetrics: { cpuLoadAvg1: 4.1, memoryPercent: 11.7, diskPercent: 6.2 },
  createdAt: '2026-09-20T08:03:12Z',
});

// ── Node 3 — near saturation: memory is the binding dimension ────────────────

export const NODE_SATURATED = node({
  id: '01M2ZQ9C8Q2T5U0V3W7X4Y6B9D',
  name: 'sam-node-20260919214455',
  providerInstanceType: 'cx43',
  providerInstanceVcpuCount: 8,
  providerInstanceMemoryMb: 16384,
  providerInstanceDiskGb: 160,
  observedProviderInstanceType: 'cx43',
  observedProviderInstanceVcpuCount: 8,
  observedProviderInstanceMemoryMb: 16384,
  observedProviderInstanceDiskGb: 160,
  providerInstancePriceDisplay: '€24.90/mo',
  vmLocation: 'hel1',
  healthStatus: 'healthy',
  lastMetrics: { cpuLoadAvg1: 88.9, memoryPercent: 94.3, diskPercent: 91.5 },
  createdAt: '2026-09-19T21:44:55Z',
});

// ── Node 4 — warm pool, zero tenants ─────────────────────────────────────────

export const NODE_WARM = node({
  id: '01M2ZQAD9R3U6V1W4X8Y5Z7C0E',
  name: 'sam-node-20260920174801',
  providerInstanceType: 'cpx31',
  providerInstanceVcpuCount: 4,
  providerInstanceMemoryMb: 8192,
  providerInstanceDiskGb: 160,
  observedProviderInstanceType: 'cpx31',
  observedProviderInstanceVcpuCount: 4,
  observedProviderInstanceMemoryMb: 8192,
  observedProviderInstanceDiskGb: 160,
  providerInstancePriceDisplay: '€13.10/mo',
  vmSize: 'small',
  lastMetrics: { cpuLoadAvg1: 0.4, memoryPercent: 3.1, diskPercent: 4.8 },
  createdAt: '2026-09-20T17:48:01Z',
});

// ── Node 5 — one exclusive tenant that claims the whole host ─────────────────

export const NODE_EXCLUSIVE = node({
  id: '01M2ZQBE0S4V7W2X5Y9Z6A8D1F',
  name: 'sam-node-20260920163027',
  providerInstanceType: 'ccx33',
  providerInstanceVcpuCount: 8,
  providerInstanceMemoryMb: 32768,
  providerInstanceDiskGb: 240,
  observedProviderInstanceType: 'ccx33',
  observedProviderInstanceVcpuCount: 8,
  observedProviderInstanceMemoryMb: 32768,
  observedProviderInstanceDiskGb: 240,
  providerInstancePriceDisplay: '€64.90/mo',
  vmSize: 'large',
  vmLocation: 'ash',
  lastMetrics: { cpuLoadAvg1: 62.8, memoryPercent: 58.4, diskPercent: 22.1 },
  createdAt: '2026-09-20T16:30:27Z',
});

// ── Node 6 — still provisioning, capacity not yet known ──────────────────────

export const NODE_UNKNOWN = node({
  id: '01M2ZQCF1T5W8X3Y6Z0A7B9E2G',
  name: 'sam-node-20260920185533',
  status: 'creating',
  healthStatus: 'stale',
  providerInstanceType: null,
  providerInstanceVcpuCount: null,
  providerInstanceMemoryMb: null,
  providerInstanceDiskGb: null,
  observedProviderInstanceType: null,
  observedProviderInstanceVcpuCount: null,
  observedProviderInstanceMemoryMb: null,
  observedProviderInstanceDiskGb: null,
  providerInstancePriceDisplay: null,
  ipAddress: null,
  lastHeartbeatAt: null,
  lastMetrics: null,
  vmLocation: 'pl-waw-1',
  cloudProvider: 'scaleway',
  createdAt: '2026-09-20T18:55:33Z',
});

export const MOCK_NODES: NodeResponse[] = [
  NODE_CX53,
  NODE_SATURATED,
  NODE_CX43,
  NODE_EXCLUSIVE,
  NODE_WARM,
  NODE_UNKNOWN,
];

// ── Tenants ──────────────────────────────────────────────────────────────────

export const MOCK_WORKSPACES: WorkspaceResponse[] = [
  // cx53 — five tenants, mixed profiles. Matches the real "5 on one cx53" shape.
  workspace({
    id: '01M2ZR01AAAA00000000000001',
    nodeId: NODE_CX53.id,
    name: 'ws-eventing-outbox',
    displayName: 'Eventing outbox reconcile',
    branch: 'sam/eventing-outbox-reconcile-4k2p1x',
    resolvedReservationJson: reservation(STANDARD_RESERVATION),
  }),
  workspace({
    id: '01M2ZR01AAAA00000000000002',
    nodeId: NODE_CX53.id,
    name: 'ws-scheduler-packing',
    displayName: 'Scheduler packing migration — explicit resource reservations across every placement path',
    branch: 'sam/migrate-scheduler-packing-to-explicit-resources-and-remove-legacy-gates-9wq3zz',
    resolvedReservationJson: reservation({ cpuMillis: 2000, memoryMb: 3584, diskMb: 20480 }),
  }),
  workspace({
    id: '01M2ZR01AAAA00000000000003',
    nodeId: NODE_CX53.id,
    name: 'ws-journal',
    displayName: 'Daily journal',
    branch: 'sam/publish-resource-history-journal-77bk2a',
    resolvedReservationJson: reservation(STANDARD_RESERVATION),
  }),
  workspace({
    id: '01M2ZR01AAAA00000000000004',
    nodeId: NODE_CX53.id,
    name: 'ws-archive-sweep',
    displayName: 'Archive sweep budget',
    branch: 'sam/raise-archive-sweep-message-budget-step-1',
    resolvedReservationJson: reservation({ cpuMillis: 1000, memoryMb: 2048, diskMb: 10240 }),
  }),
  workspace({
    id: '01M2ZR01AAAA00000000000005',
    nodeId: NODE_CX53.id,
    name: 'ws-a',
    displayName: 'A',
    branch: 'x',
    status: 'recovery',
    resolvedReservationJson: reservation(STANDARD_RESERVATION),
  }),

  // cx43 — a single tenant with an aggressively long label.
  workspace({
    id: '01M2ZR02BBBB00000000000001',
    nodeId: NODE_CX43.id,
    name: 'ws-node-card-resource-visualisation-prototype-exploration',
    displayName:
      'Prototype resource-utilization visualizations for the infrastructure nodes page — concepts, stress fixtures and screenshot review 🛠️📊',
    branch: 'sam/prototype-resource-utilization-visualizations-eavxxg',
    vmLocation: 'nbg1',
    resolvedReservationJson: reservation({ cpuMillis: 1000, memoryMb: 2048, diskMb: 10240 }),
  }),

  // Saturated cx43 — four tenants, memory-bound.
  workspace({
    id: '01M2ZR03CCCC00000000000001',
    nodeId: NODE_SATURATED.id,
    name: 'ws-do-storage-relief',
    displayName: 'ProjectData storage relief',
    branch: 'sam/project-data-archive-sharding',
    vmLocation: 'hel1',
    resolvedReservationJson: reservation({ cpuMillis: 2000, memoryMb: 3584, diskMb: 40960 }),
  }),
  workspace({
    id: '01M2ZR03CCCC00000000000002',
    nodeId: NODE_SATURATED.id,
    name: 'ws-vm-agent-rollout',
    displayName: 'VM agent content-identity rollout',
    branch: 'sam/agent-version-content-identity',
    vmLocation: 'hel1',
    resolvedReservationJson: reservation({ cpuMillis: 2000, memoryMb: 3584, diskMb: 40960 }),
  }),
  workspace({
    id: '01M2ZR03CCCC00000000000003',
    nodeId: NODE_SATURATED.id,
    name: 'ws-cost-audit',
    displayName: 'Cloudflare cost audit',
    branch: 'sam/cloudflare-cost-billed-metric',
    vmLocation: 'hel1',
    resolvedReservationJson: reservation({ cpuMillis: 2000, memoryMb: 3584, diskMb: 40960 }),
  }),
  workspace({
    id: '01M2ZR03CCCC00000000000004',
    nodeId: NODE_SATURATED.id,
    name: 'ws-incident-triage',
    displayName: 'Private incident triage',
    branch: 'sam/incident-triage-dedup',
    vmLocation: 'hel1',
    status: 'recovery',
    resolvedReservationJson: reservation({ cpuMillis: 1400, memoryMb: 4600, diskMb: 30720 }),
  }),

  // Exclusive node — one tenant that owns the host.
  workspace({
    id: '01M2ZR05EEEE00000000000001',
    nodeId: NODE_EXCLUSIVE.id,
    name: 'ws-full-suite',
    displayName: 'Full monorepo test suite',
    branch: 'sam/full-suite-verification',
    vmLocation: 'ash',
    resolvedReservationJson: reservation({
      cpuMillis: 8000,
      memoryMb: 32256,
      diskMb: 245760,
      exclusiveNode: true,
      source: 'task',
    }),
  }),
];

/**
 * Measured usage keyed by workspace id. Absent entries mean "no telemetry yet",
 * which every concept must render without inventing a number.
 */
export const MOCK_MEASURED: Record<string, MeasuredUsage> = {
  '01M2ZR01AAAA00000000000001': {
    cpuMeanMillis: 118, cpuPeakMillis: 980,
    memoryMeanBytes: 412 * MB, memoryPeakBytes: 690 * MB,
    diskUsedMb: 1180, oomCount: 0, sampleCount: 2841,
  },
  // Reserved 3584 MB, peaked 4102 MB and took an OOM kill — the headline case
  // for "reserved is not what actually happened".
  '01M2ZR01AAAA00000000000002': {
    cpuMeanMillis: 1460, cpuPeakMillis: 3920,
    memoryMeanBytes: 2904 * MB, memoryPeakBytes: 4102 * MB,
    diskUsedMb: 14730, oomCount: 1, sampleCount: 3910,
  },
  '01M2ZR01AAAA00000000000003': {
    cpuMeanMillis: 64, cpuPeakMillis: 410,
    memoryMeanBytes: 288 * MB, memoryPeakBytes: 501 * MB,
    diskUsedMb: 760, oomCount: 0, sampleCount: 1204,
  },
  // 01M2ZR01AAAA00000000000005 is deliberately absent: no telemetry yet.
  '01M2ZR01AAAA00000000000004': {
    cpuMeanMillis: 210, cpuPeakMillis: 1610,
    memoryMeanBytes: 690 * MB, memoryPeakBytes: 1340 * MB,
    diskUsedMb: 3980, oomCount: 0, sampleCount: 2011,
  },
  '01M2ZR02BBBB00000000000001': {
    cpuMeanMillis: 340, cpuPeakMillis: 2180,
    memoryMeanBytes: 980 * MB, memoryPeakBytes: 1620 * MB,
    diskUsedMb: 5120, oomCount: 0, sampleCount: 1588,
  },
  '01M2ZR03CCCC00000000000001': {
    cpuMeanMillis: 1880, cpuPeakMillis: 4100,
    memoryMeanBytes: 3310 * MB, memoryPeakBytes: 3570 * MB,
    diskUsedMb: 38100, oomCount: 0, sampleCount: 4400,
  },
  '01M2ZR03CCCC00000000000002': {
    cpuMeanMillis: 1710, cpuPeakMillis: 3980,
    memoryMeanBytes: 3190 * MB, memoryPeakBytes: 3580 * MB,
    diskUsedMb: 36400, oomCount: 0, sampleCount: 4120,
  },
  '01M2ZR03CCCC00000000000003': {
    cpuMeanMillis: 1590, cpuPeakMillis: 3840,
    memoryMeanBytes: 2980 * MB, memoryPeakBytes: 3520 * MB,
    diskUsedMb: 34900, oomCount: 0, sampleCount: 3980,
  },
  '01M2ZR03CCCC00000000000004': {
    cpuMeanMillis: 1240, cpuPeakMillis: 2900,
    memoryMeanBytes: 4180 * MB, memoryPeakBytes: 4610 * MB,
    diskUsedMb: 28800, oomCount: 2, sampleCount: 3110,
  },
  '01M2ZR05EEEE00000000000001': {
    cpuMeanMillis: 5120, cpuPeakMillis: 7960,
    memoryMeanBytes: 11400 * MB, memoryPeakBytes: 19800 * MB,
    diskUsedMb: 51200, oomCount: 0, sampleCount: 6200,
  },
};
