import type { NodeResponse } from '@simple-agent-manager/shared';
import { eq, inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { deriveNodeHealth, recordNodeHealthEvent } from '../../services/node-health';

type DeploymentEnvironmentNodeSummary = NonNullable<NodeResponse['deploymentEnvironments']>[number];

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
    providerInstanceBootDiskSizeGb: node.providerInstanceBootDiskSizeGb ?? null,
    providerInstanceImage: node.providerInstanceImage ?? null,
    providerInstanceArchitecture: node.providerInstanceArchitecture ?? null,
    observedProviderInstanceType: node.observedProviderInstanceType ?? null,
    observedProviderInstanceVcpuCount: node.observedProviderInstanceVcpuCount ?? null,
    observedProviderInstanceMemoryMb: node.observedProviderInstanceMemoryMb ?? null,
    observedProviderInstanceDiskGb: node.observedProviderInstanceDiskGb ?? null,
    observedHardwareJson: node.observedHardwareJson ?? null,
    observedHardwareSource: node.observedHardwareSource ?? null,
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
  node: schema.Node,
  env: Env
): Promise<schema.Node> {
  const computedHealth = deriveNodeHealth(node, Date.now());
  if (computedHealth === node.healthStatus) {
    return node;
  }

  const updatedAt = new Date().toISOString();
  const updated = await env.DATABASE.prepare(
    `UPDATE nodes SET health_status = ?, updated_at = ?
     WHERE id = ? AND status = ? AND last_heartbeat_at IS ? AND health_status = ?`
  )
    .bind(computedHealth, updatedAt, node.id, node.status, node.lastHeartbeatAt, node.healthStatus)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) {
    const [current] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, node.id));
    return current ?? node;
  }

  await recordNodeHealthEvent(env, {
    nodeId: node.id,
    episodeStartedAt: node.lastHeartbeatAt ?? node.createdAt,
    event: computedHealth,
    reason: computedHealth === 'healthy' ? 'node_heartbeat_resumed' : 'node_heartbeat_missing',
    createdAt: updatedAt,
  });

  return {
    ...node,
    healthStatus: computedHealth,
    updatedAt,
  };
}
