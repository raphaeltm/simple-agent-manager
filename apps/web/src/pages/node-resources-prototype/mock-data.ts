// PROTOTYPE — stress-test fixtures. Never ships to production.
import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';

const NOW = '2026-09-20T09:12:00.000Z';

export interface NodeFixture {
  node: NodeResponse;
  workspaces: WorkspaceResponse[];
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
    ipAddress: '65.108.12.34',
    lastHeartbeatAt: NOW,
    lastMetrics: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function hardware(type: string, vcpu: number, memoryMb: number, diskGb: number, price: string) {
  return {
    providerInstanceType: type,
    providerInstanceVcpuCount: vcpu,
    providerInstanceMemoryMb: memoryMb,
    providerInstanceDiskGb: diskGb,
    providerInstanceArchitecture: 'x86',
    observedProviderInstanceType: type,
    observedProviderInstanceVcpuCount: vcpu,
    observedProviderInstanceMemoryMb: memoryMb,
    observedProviderInstanceDiskGb: diskGb,
    providerInstancePriceDisplay: price,
  } satisfies Partial<NodeResponse>;
}

function reservation(cpuMillis: number, memoryMb: number, diskMb: number): string {
  return JSON.stringify({
    cpuMillis,
    memoryMb,
    diskMb,
    exclusiveNode: false,
    maxCoTenants: 4,
    source: 'agent-profile',
    sourceId: '01KTX849BEN08SNZ84H0DJJDZD',
    version: 1,
  });
}

function workspace(
  partial: Partial<WorkspaceResponse> & Pick<WorkspaceResponse, 'id' | 'name' | 'nodeId'>
): WorkspaceResponse {
  return {
    repository: 'raphaeltm/simple-agent-manager',
    branch: 'main',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    vmIp: null,
    lastActivityAt: NOW,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

/** Near-full 8 vCPU node with three mixed-size reservations and live telemetry. */
const busy: NodeFixture = {
  node: node({
    id: 'n1',
    name: 'sam-agents-eu-1',
    ...hardware('cx43', 8, 16384, 160, '€13.49/mo'),
    lastMetrics: { cpuLoadAvg1: 3.2, memoryPercent: 71, diskPercent: 58 },
  }),
  workspaces: [
    workspace({ id: 'w1', nodeId: 'n1', name: 'pr-2107-deploy-marker', branch: 'fix/deploy-marker-condition', resolvedReservationJson: reservation(2000, 4096, 40960) }),
    workspace({ id: 'w2', nodeId: 'n1', name: 'nodes-viz-concepts', branch: 'sam/think-infrastructurenodes-page-cool-ds09ha', resolvedReservationJson: reservation(1000, 2048, 20480) }),
    workspace({ id: 'w3', nodeId: 'n1', name: 'eventing-staging-sweep', branch: 'sam/eventing-feature', status: 'sleeping', resolvedReservationJson: reservation(4000, 8192, 81920) }),
  ],
};

/** Small node whose single workspace consumed every allocatable MB (memory Full). */
const full: NodeFixture = {
  node: node({
    id: 'n2',
    name: 'node-20260919t142233',
    vmLocation: 'hel1',
    ...hardware('cpx21', 3, 4096, 80, '€8.98/mo'),
    lastMetrics: { cpuLoadAvg1: 0.4, memoryPercent: 88, diskPercent: 22 },
  }),
  workspaces: [
    workspace({ id: 'w4', nodeId: 'n2', name: 'codex-hotfix-startup', branch: 'sam/startup-hotfix-vqes2', resolvedReservationJson: reservation(2000, 3584, 20480) }),
  ],
};

/** Warm node: nothing reserved, everything free. */
const warm: NodeFixture = {
  node: node({
    id: 'n3',
    name: 'warm-hel1-b',
    vmLocation: 'hel1',
    ...hardware('cx33', 4, 8192, 80, '€5.49/mo'),
    lastMetrics: { cpuLoadAvg1: 0.05, memoryPercent: 12, diskPercent: 9 },
  }),
  workspaces: [],
};

/** Legacy node with no hardware record: capacity unknown, one reservation unreadable. */
const legacy: NodeFixture = {
  node: node({
    id: 'n4',
    name: 'legacy-node-no-hardware',
    vmSize: 'large',
    vmLocation: 'nbg1',
    healthStatus: 'stale',
    lastHeartbeatAt: '2026-09-19T21:40:00.000Z',
  }),
  workspaces: [
    workspace({ id: 'w5', nodeId: 'n4', name: 'billing-reconcile', branch: 'sam/billing-reconcile', resolvedReservationJson: reservation(2000, 4096, 40960) }),
    workspace({ id: 'w6', nodeId: 'n4', name: 'docs-refresh', branch: 'docs/self-host-guide', status: 'stopped' }),
  ],
};

/** Deployment node: resource concepts do not apply; card must stay unchanged. */
const deployment: NodeFixture = {
  node: node({
    id: 'n5',
    name: 'deploy-prod-web',
    nodeRole: 'deployment',
    ...hardware('cx23', 2, 4096, 40, '€3.79/mo'),
    lastMetrics: { cpuLoadAvg1: 0.3, memoryPercent: 45, diskPercent: 33 },
    deploymentEnvironments: [
      { id: 'e1', projectId: 'p1', name: 'Production' },
      { id: 'e2', projectId: 'p1', name: 'Staging' },
    ],
  }),
  workspaces: [],
};

/** Stress: long name, seven workspaces, over-committed on every axis, no telemetry, unhealthy. */
const stress: NodeFixture = {
  node: node({
    id: 'n6',
    name: 'stress-node-with-an-extremely-long-name-that-should-truncate-gracefully-on-mobile-viewports',
    healthStatus: 'unhealthy',
    ...hardware('cx53', 16, 32768, 320, '€29.49/mo'),
    errorMessage: 'Heartbeat missed 3 consecutive intervals; last agent report 14 minutes ago.',
  }),
  workspaces: [
    workspace({ id: 'w7', nodeId: 'n6', name: 'project-data-archive-sharding-terminal-consolidation-phase-2', branch: 'sam/archive-sharding-phase-2-with-a-very-long-branch-name', resolvedReservationJson: reservation(4000, 8192, 81920) }),
    workspace({ id: 'w8', nodeId: 'n6', name: 'eventing-piece-7', branch: 'sam/eventing-feature', status: 'recovery', resolvedReservationJson: reservation(4000, 8192, 81920) }),
    workspace({ id: 'w9', nodeId: 'n6', name: 'x', branch: 'y', resolvedReservationJson: reservation(2000, 4096, 40960) }),
    workspace({ id: 'w10', nodeId: 'n6', name: 'comments-nav-followup', branch: 'sam/comments-nav', resolvedReservationJson: reservation(2000, 4096, 40960) }),
    workspace({ id: 'w11', nodeId: 'n6', name: 'cli-quality-pass', branch: 'sam/cli-quality', status: 'sleeping', resolvedReservationJson: reservation(2000, 4096, 40960) }),
    workspace({ id: 'w12', nodeId: 'n6', name: 'wrangler-sync-fix', branch: 'fix/wrangler-sync', resolvedReservationJson: reservation(2000, 4096, 40960) }),
    workspace({ id: 'w13', nodeId: 'n6', name: 'tool-activity-cards', branch: 'sam/optimize-ui-chat-sessions-wshgke', resolvedReservationJson: reservation(1000, 2048, 20480) }),
  ],
};

/** Node still provisioning: no telemetry, no reservations yet. */
const creating: NodeFixture = {
  node: node({
    id: 'n7',
    name: 'node-20260920t091100',
    status: 'creating',
    healthStatus: 'stale',
    ipAddress: null,
    lastHeartbeatAt: null,
    ...hardware('cx33', 4, 8192, 80, '€5.49/mo'),
  }),
  workspaces: [],
};

export const NODE_FIXTURES: NodeFixture[] = [busy, full, warm, legacy, deployment, stress, creating];
