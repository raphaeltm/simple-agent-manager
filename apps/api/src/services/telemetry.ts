import type { Env } from '../index';

export type TelemetryMetricName =
  | 'node_agent_request'
  | 'node_agent_response'
  | 'ws_proxy_route'
  | 'sc_002_workspace_creation_flow'
  | 'sc_006_node_efficiency';

export interface NodeRoutingMetric {
  metric: TelemetryMetricName;
  nodeId: string;
  workspaceId?: string | null;
  userId?: string | null;
  repository?: string | null;
  reusedExistingNode?: boolean;
  workspaceCountOnNodeBefore?: number;
  nodeCountForUser?: number;
  workspaceCountForUser?: number;
  statusCode?: number;
  durationMs?: number;
}

interface MetricAggregate {
  metric: TelemetryMetricName;
  count: number;
  lastSeenAt: string;
  lastStatusCode?: number;
  statusCodeCounts: Record<string, number>;
  duration: {
    totalMs: number;
    maxMs: number;
    sampleCount: number;
  };
  sc002: {
    totalAttempts: number;
    reusedNodeAttempts: number;
    secondWorkspaceOnExistingNodeAttempts: number;
  };
  sc006: {
    samples: number;
    totalNodesAcrossSamples: number;
    totalWorkspacesAcrossSamples: number;
  };
}

const metricState = new Map<TelemetryMetricName, MetricAggregate>();

function getOrCreateAggregate(metric: TelemetryMetricName): MetricAggregate {
  const existing = metricState.get(metric);
  if (existing) {
    return existing;
  }

  const created: MetricAggregate = {
    metric,
    count: 0,
    lastSeenAt: new Date(0).toISOString(),
    statusCodeCounts: {},
    duration: {
      totalMs: 0,
      maxMs: 0,
      sampleCount: 0,
    },
    sc002: {
      totalAttempts: 0,
      reusedNodeAttempts: 0,
      secondWorkspaceOnExistingNodeAttempts: 0,
    },
    sc006: {
      samples: 0,
      totalNodesAcrossSamples: 0,
      totalWorkspacesAcrossSamples: 0,
    },
  };

  metricState.set(metric, created);
  return created;
}

function updateAggregate(metric: NodeRoutingMetric): MetricAggregate {
  const aggregate = getOrCreateAggregate(metric.metric);
  const now = new Date().toISOString();

  aggregate.count += 1;
  aggregate.lastSeenAt = now;

  if (typeof metric.statusCode === 'number') {
    aggregate.lastStatusCode = metric.statusCode;
    const key = String(metric.statusCode);
    aggregate.statusCodeCounts[key] = (aggregate.statusCodeCounts[key] || 0) + 1;
  }

  if (typeof metric.durationMs === 'number' && Number.isFinite(metric.durationMs) && metric.durationMs >= 0) {
    aggregate.duration.sampleCount += 1;
    aggregate.duration.totalMs += metric.durationMs;
    aggregate.duration.maxMs = Math.max(aggregate.duration.maxMs, metric.durationMs);
  }

  if (metric.metric === 'sc_002_workspace_creation_flow') {
    aggregate.sc002.totalAttempts += 1;
    if (metric.reusedExistingNode) {
      aggregate.sc002.reusedNodeAttempts += 1;
    }
    if ((metric.workspaceCountOnNodeBefore || 0) >= 1 && metric.reusedExistingNode) {
      aggregate.sc002.secondWorkspaceOnExistingNodeAttempts += 1;
    }
  }

  if (metric.metric === 'sc_006_node_efficiency') {
    aggregate.sc006.samples += 1;
    aggregate.sc006.totalNodesAcrossSamples += metric.nodeCountForUser || 0;
    aggregate.sc006.totalWorkspacesAcrossSamples += metric.workspaceCountForUser || 0;
  }

  return aggregate;
}

export function getTelemetrySnapshot(): Record<string, MetricAggregate> {
  return Object.fromEntries(metricState.entries());
}

/**
 * Lightweight telemetry sink for pre-production deployments.
 * Emits structured logs for SC-002/SC-006 tracking.
 */
export function recordNodeRoutingMetric(metric: NodeRoutingMetric, _env: Env): void {
  const aggregate = updateAggregate(metric);
  console.log(JSON.stringify({
    event: 'telemetry',
    ...metric,
    aggregate,
    ts: new Date().toISOString(),
  }));
}
