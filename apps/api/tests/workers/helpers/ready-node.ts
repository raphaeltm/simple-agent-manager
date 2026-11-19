import type { CapacityPlacementSnapshot } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';

import type { Env } from '../../../src/env';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../../src/services/capacity-placement-snapshot';
import { seedNode } from './seed-d1';

/** Seed a healthy, agent-ready VM node whose placement identity is `snapshot`. */
export async function seedReadyNode(
  nodeId: string,
  userId: string,
  snapshot: CapacityPlacementSnapshot
): Promise<void> {
  const now = new Date().toISOString();
  await seedNode(nodeId, userId, {
    vmSize: 'small',
    vmLocation: 'nbg1',
    status: 'running',
    healthStatus: 'healthy',
    lastHeartbeatAt: now,
  });
  await env.DATABASE.prepare(
    `UPDATE nodes
        SET agent_ready_at = ?,
            agent_version = ?,
            runtime = 'vm',
            node_role = 'workspace',
            cloud_provider = 'hetzner',
            provider_instance_id = ?,
            observed_hardware_source = 'observed',
            observed_provider_instance_vcpu_count = ?,
            observed_provider_instance_memory_mb = ?,
            observed_provider_instance_disk_gb = ?,
            ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS},
            last_metrics = ?
      WHERE id = ?`
  )
    .bind(
      now,
      (env as unknown as Env).VM_AGENT_REQUIRED_VERSION ??
        '0123456789abcdef0123456789abcdef01234567',
      `provider-${nodeId}`,
      snapshot.providerInstanceVcpuCount,
      snapshot.providerInstanceMemoryMb,
      snapshot.providerInstanceDiskGb,
      ...capacityPlacementSnapshotSqlValues(snapshot),
      JSON.stringify({ version: 1, cpuLoadAvg1: 0.1, memoryPercent: 10, diskPercent: 10 }),
      nodeId
    )
    .run();
}
