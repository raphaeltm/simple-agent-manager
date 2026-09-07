import type { NodeHealthStatus, NodeResponse } from '@simple-agent-manager/shared';
import { eq, inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';

type DeploymentEnvironmentNodeSummary = NonNullable<NodeResponse['deploymentEnvironments']>[number];

function deriveHealthStatus(node: schema.Node, now: number): NodeHealthStatus {
  if (node.status !== 'running') {
    return (node.healthStatus as NodeHealthStatus) || 'stale';
  }

  if (!node.lastHeartbeatAt) {
    return 'stale';
  }

  const lastHeartbeat = Date.parse(node.lastHeartbeatAt);
  if (Number.isNaN(lastHeartbeat)) {
    return 'unhealthy';
  }

  const ageSeconds = Math.max(0, Math.floor((now - lastHeartbeat) / 1000));
  const staleThreshold = Math.max(1, node.heartbeatStaleAfterSeconds || 180);

  if (ageSeconds <= staleThreshold) {
    return 'healthy';
  }
  if (ageSeconds <= staleThreshold * 2) {
    return 'stale';
  }
  return 'unhealthy';
}

export function toNodeResponse(
  node: schema.Node,
  deploymentEnvironments: DeploymentEnvironmentNodeSummary[] = []
): NodeResponse {
  let lastMetrics: NodeResponse['lastMetrics'] = null;
  if (node.lastMetrics) {
    try {
      lastMetrics = JSON.parse(node.lastMetrics);
    } catch {
      // Ignore malformed JSON in lastMetrics
    }
  }

  return {
    id: node.id,
    name: node.name,
    status: node.status as NodeResponse['status'],
    healthStatus: node.healthStatus as NodeResponse['healthStatus'],
    cloudProvider: (node.cloudProvider as NodeResponse['cloudProvider']) ?? null,
    vmSize: node.vmSize as NodeResponse['vmSize'],
    vmLocation: node.vmLocation as NodeResponse['vmLocation'],
    providerInstanceType: node.providerInstanceType ?? null,
    providerInstanceVcpuCount: node.providerInstanceVcpuCount ?? null,
    providerInstanceMemoryMb: node.providerInstanceMemoryMb ?? null,
    providerInstanceDiskGb: node.providerInstanceDiskGb ?? null,
    providerInstancePriceDisplay: node.providerInstancePriceDisplay ?? null,
    providerInstancePriceCurrency: node.providerInstancePriceCurrency ?? null,
    providerInstancePriceMonthlyCents: node.providerInstancePriceMonthlyCents ?? null,
    providerInstancePriceHourlyMicros: node.providerInstancePriceHourlyMicros ?? null,
    nodeRole: (node.nodeRole ?? 'workspace') as NodeResponse['nodeRole'],
    nodeClass: (node.nodeClass ?? 'managed') as NodeResponse['nodeClass'],
    transport: (node.transport as NodeResponse['transport']) ?? null,
    tunnelName: node.tunnelName ?? null,
    ipAddress: node.ipAddress,
    lastHeartbeatAt: node.lastHeartbeatAt,
    heartbeatStaleAfterSeconds: node.heartbeatStaleAfterSeconds,
    lastMetrics,
    deploymentEnvironments,
    errorMessage: node.errorMessage,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export async function loadDeploymentEnvironmentSummaries(
  db: ReturnType<typeof drizzle<typeof schema>>,
  nodeIds: string[]
): Promise<Map<string, DeploymentEnvironmentNodeSummary[]>> {
  if (nodeIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      projectId: schema.deploymentEnvironments.projectId,
      name: schema.deploymentEnvironments.name,
      nodeId: schema.deploymentEnvironments.nodeId,
    })
    .from(schema.deploymentEnvironments)
    .where(inArray(schema.deploymentEnvironments.nodeId, nodeIds));

  const byNode = new Map<string, DeploymentEnvironmentNodeSummary[]>();
  for (const row of rows) {
    if (!row.nodeId) continue;
    const existing = byNode.get(row.nodeId) ?? [];
    existing.push({ id: row.id, projectId: row.projectId, name: row.name });
    byNode.set(row.nodeId, existing);
  }
  for (const environments of byNode.values()) {
    environments.sort((a, b) => a.name.localeCompare(b.name));
  }
  return byNode;
}

export async function refreshNodeHealth(
  db: ReturnType<typeof drizzle<typeof schema>>,
  node: schema.Node
): Promise<schema.Node> {
  const computedHealth = deriveHealthStatus(node, Date.now());
  if (computedHealth === node.healthStatus) {
    return node;
  }

  await db
    .update(schema.nodes)
    .set({
      healthStatus: computedHealth,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.nodes.id, node.id));

  return {
    ...node,
    healthStatus: computedHealth,
    updatedAt: new Date().toISOString(),
  };
}
