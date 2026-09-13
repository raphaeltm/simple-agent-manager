import { type CapacityWorkloadRole } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { capacityPlacementAuthorityGeneration } from './capacity-pool-authority';
import { resolveCapacityPoolPlacementSettings } from './capacity-pool-placement-settings';
import {
  buildPlacementAuthoritySqlPredicate,
  PROVIDER_ALLOCATION_ACTIVE_STATUS_SQL,
} from './placement-authority';

type NodeAllocationPlanGuardRow = {
  id: string;
  user_id: string;
  status: string;
  runtime: string | null;
  node_class: string | null;
  node_role: string | null;
  workload_role: string | null;
  cloud_provider: string | null;
  vm_location: string | null;
  capacity_pool_id: string | null;
  capacity_pool_scope: string | null;
  capacity_pool_revision: number | null;
  capacity_source_id: string | null;
  capacity_source_generation: number | null;
  capacity_source_external_ref: string | null;
  capacity_pool_candidate_id: string | null;
  capacity_pool_project_id: string | null;
  placement_credential_source: string | null;
  placement_credential_reference: string | null;
  placement_credential_version: number | null;
  selection_settings_version: number | null;
  capacity_authority_generation: number | null;
  provider_instance_type: string | null;
  provider_instance_vcpu_count: number | null;
  provider_instance_memory_mb: number | null;
  provider_instance_disk_gb: number | null;
  provider_instance_boot_disk_size_gb: number | null;
  provider_instance_image: string | null;
  provider_instance_architecture: string | null;
  provider_instance_price_display: string | null;
  provider_instance_price_currency: string | null;
  provider_instance_price_monthly_cents: number | null;
  provider_instance_price_hourly_micros: number | null;
  placement_explanation_json: string | null;
  pool_revision: number | null;
  source_authority_generation: number | null;
  candidate_authority_generation: number | null;
};

/**
 * Role the caller intends to place. The node row cannot supply this: deriving the
 * expected role from the same row being validated makes the check self-consistent,
 * so a row whose `workload_role` drifted to another role would validate against
 * itself instead of being rejected.
 */
export interface NodeAllocationPlanRole {
  nodeRole: 'workspace' | 'deployment';
  workloadRole: CapacityWorkloadRole;
}

export async function assertNodeAllocationPlanCurrent(
  env: Env,
  nodeId: string,
  userId: string,
  projectId: string | null,
  expectedRole: NodeAllocationPlanRole = { nodeRole: 'workspace', workloadRole: 'workspace' }
): Promise<void> {
  if (!env.DATABASE || typeof env.DATABASE.prepare !== 'function') {
    throw new Error('Node allocation authority database is unavailable');
  }
  const row = await env.DATABASE.prepare(
    `SELECT
       n.id,
       n.user_id,
       n.status,
       n.runtime,
       n.node_class,
       n.node_role,
       n.workload_role,
       n.cloud_provider,
       n.vm_location,
       n.capacity_pool_id,
       n.capacity_pool_scope,
       n.capacity_pool_revision,
       n.capacity_source_id,
       n.capacity_source_generation,
       n.capacity_source_external_ref,
       n.capacity_pool_candidate_id,
       n.capacity_pool_project_id,
       n.placement_credential_source,
       n.placement_credential_reference,
       n.placement_credential_version,
       n.selection_settings_version,
       n.capacity_authority_generation,
       n.provider_instance_type,
       n.provider_instance_vcpu_count,
       n.provider_instance_memory_mb,
       n.provider_instance_disk_gb,
       n.provider_instance_boot_disk_size_gb,
       n.provider_instance_image,
       n.provider_instance_architecture,
       n.provider_instance_price_display,
       n.provider_instance_price_currency,
       n.provider_instance_price_monthly_cents,
       n.provider_instance_price_hourly_micros,
       n.placement_explanation_json,
       p.revision AS pool_revision,
       s.authority_generation AS source_authority_generation,
       c.authority_generation AS candidate_authority_generation
     FROM nodes n
     LEFT JOIN capacity_pools p ON p.id = n.capacity_pool_id
     LEFT JOIN capacity_sources s ON s.id = n.capacity_source_id
     LEFT JOIN capacity_pool_candidates c ON c.id = n.capacity_pool_candidate_id
     WHERE n.id = ?`
  )
    .bind(nodeId)
    .first<NodeAllocationPlanGuardRow>();

  if (!row) {
    throw new Error('Node allocation record disappeared before provider allocation');
  }
  if (row.user_id !== userId) {
    throw new Error('Node allocation user changed before provider allocation');
  }
  const { nodeRole, workloadRole } = expectedRole;
  const predicate = buildPlacementAuthoritySqlPredicate({
    userId,
    projectId,
    nodeRole,
    workloadRole,
    capacityPlacementSnapshot: {
      capacityPoolId: row.capacity_pool_id,
      capacityPoolScope:
        row.capacity_pool_scope === 'installation' ||
        row.capacity_pool_scope === 'user' ||
        row.capacity_pool_scope === 'project'
          ? row.capacity_pool_scope
          : null,
      capacityPoolRevision: row.capacity_pool_revision,
      capacitySourceId: row.capacity_source_id,
      capacitySourceGeneration: row.capacity_source_generation,
      capacitySourceExternalRef: row.capacity_source_external_ref,
      capacityPoolCandidateId: row.capacity_pool_candidate_id,
      placementCredentialSource:
        row.placement_credential_source === 'user' ||
        row.placement_credential_source === 'project' ||
        row.placement_credential_source === 'platform'
          ? row.placement_credential_source
          : null,
      placementCredentialReference: row.placement_credential_reference,
      placementCredentialVersion: row.placement_credential_version,
      capacityPoolProjectId: row.capacity_pool_project_id,
      workloadRole,
      providerInstanceType: row.provider_instance_type,
      providerInstanceVcpuCount: row.provider_instance_vcpu_count,
      providerInstanceMemoryMb: row.provider_instance_memory_mb,
      providerInstanceDiskGb: row.provider_instance_disk_gb,
      providerInstanceBootDiskSizeGb: row.provider_instance_boot_disk_size_gb,
      providerInstanceImage: row.provider_instance_image,
      providerInstanceArchitecture: row.provider_instance_architecture,
      providerInstancePriceDisplay: row.provider_instance_price_display,
      providerInstancePriceCurrency: row.provider_instance_price_currency,
      providerInstancePriceMonthlyCents: row.provider_instance_price_monthly_cents,
      providerInstancePriceHourlyMicros: row.provider_instance_price_hourly_micros,
      placementExplanationJson: row.placement_explanation_json,
    },
    requireProjectMembership: projectId !== null,
  });
  const current = await env.DATABASE.prepare(
    `SELECT 1 AS ok
     FROM nodes n
     WHERE n.id = ?
       AND n.user_id = ?
       AND n.status IN (${PROVIDER_ALLOCATION_ACTIVE_STATUS_SQL})
       ${predicate.sql}
     LIMIT 1`
  )
    .bind(nodeId, userId, ...predicate.binds)
    .first<{ ok: number }>();
  if (!current) {
    throw new Error('Node allocation plan is no longer current');
  }
  if (row.capacity_authority_generation !== null) {
    const settings = await resolveCapacityPoolPlacementSettings(
      drizzle(env.DATABASE, { schema }),
      env
    );
    if (
      row.selection_settings_version !== null &&
      row.selection_settings_version !== settings.placementSettings.sourceGeneration
    ) {
      throw new Error('Selected capacity placement settings changed after placement');
    }
    const currentAuthority = capacityPlacementAuthorityGeneration({
      poolRevision: row.pool_revision,
      selectionSettingsGeneration: settings.placementSettings.sourceGeneration,
      sourceAuthorityGeneration: row.source_authority_generation,
      candidateAuthorityGeneration: row.candidate_authority_generation,
    });
    if (row.capacity_authority_generation !== currentAuthority) {
      throw new Error('Selected capacity authority changed after placement');
    }
  }
}
