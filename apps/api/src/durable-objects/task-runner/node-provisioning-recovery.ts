/**
 * Crash-recovery adoption for the TaskRunner `node_provisioning` step.
 *
 * Split out of `node-provisioning-step.ts` (rule 18). Pure code motion: the
 * block below ran inline at the top of `handleNodeProvisioning`.
 */
import type { VMSize } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  type CapacityPlacementSnapshotRow,
  toCapacityPlacementSnapshot,
} from '../../services/capacity-pools';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function adoptProvisionedNodeAfterCrash(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  // Self-healing recovery: a prior attempt may have provisioned a node in D1
  // (and in the cloud) but crashed before persisting nodeId to DO storage. The
  // task row records the node via auto_provisioned_node_id, which is written
  // BEFORE provisionNode (so it survives the crash window between provision
  // success and the storage.put below). Adopt that node instead of creating a
  // duplicate (orphan). Capacity-failed nodes are deleted from D1, so a
  // missing/dead row means the attempt failed and we should (re)provision below.
  if (!state.stepResults.nodeId) {
    const taskRow = await rc.env.DATABASE.prepare(
      `SELECT auto_provisioned_node_id FROM tasks WHERE id = ?`
    )
      .bind(state.taskId)
      .first<{ auto_provisioned_node_id: string | null }>();
    const recoveredNodeId = taskRow?.auto_provisioned_node_id ?? null;
    if (recoveredNodeId) {
      const existing = await rc.env.DATABASE.prepare(
        `SELECT
           id,
           status,
           vm_size AS vmSize,
           capacity_pool_id AS capacityPoolId,
           capacity_pool_scope AS capacityPoolScope,
           capacity_pool_revision AS capacityPoolRevision,
           capacity_source_id AS capacitySourceId,
           capacity_pool_candidate_id AS capacityPoolCandidateId,
           placement_credential_source AS placementCredentialSource,
           placement_credential_reference AS placementCredentialReference,
           placement_credential_version AS placementCredentialVersion,
           capacity_pool_project_id AS capacityPoolProjectId,
           workload_role AS workloadRole,
           provider_instance_type AS providerInstanceType,
           provider_instance_vcpu_count AS providerInstanceVcpuCount,
           provider_instance_memory_mb AS providerInstanceMemoryMb,
           provider_instance_disk_gb AS providerInstanceDiskGb,
           provider_instance_boot_disk_size_gb AS providerInstanceBootDiskSizeGb,
           provider_instance_image AS providerInstanceImage,
           provider_instance_architecture AS providerInstanceArchitecture,
           provider_instance_price_display AS providerInstancePriceDisplay,
           provider_instance_price_currency AS providerInstancePriceCurrency,
           provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
           provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
           placement_explanation_json AS placementExplanationJson
         FROM nodes WHERE id = ?`
      )
        .bind(recoveredNodeId)
        .first<
          (CapacityPlacementSnapshotRow & { id: string; status: string; vmSize: string }) | null
        >();
      if (
        existing &&
        (existing.status === 'running' ||
          existing.status === 'creating' ||
          existing.status === 'recovery')
      ) {
        const recoveredSize = existing.vmSize as VMSize;
        const requestedBeforeRecovery = state.config.vmSize;
        state.stepResults.nodeId = existing.id;
        state.stepResults.autoProvisioned = true;
        state.stepResults.provisionedVmSize = recoveredSize;
        const recoveredSnapshot = toCapacityPlacementSnapshot(existing);
        state.stepResults.capacityPlacementSnapshot = recoveredSnapshot.capacityPoolId
          ? recoveredSnapshot
          : null;
        state.config.vmSize = recoveredSize;
        state.provisioningStartedAt ??= Date.now();
        await rc.ctx.storage.put('state', state);
        log.info('task_runner_do.node_provisioning.recovered', {
          taskId: state.taskId,
          nodeId: existing.id,
          recoveredVmSize: recoveredSize,
          requestedVmSize: requestedBeforeRecovery,
        });
        if (recoveredSize !== requestedBeforeRecovery) {
          // Re-record the downgrade in case the crash happened before it was
          // persisted on the original success path.
          await rc.env.DATABASE.prepare(
            `UPDATE tasks SET provisioned_vm_size = ?, updated_at = ? WHERE id = ?`
          )
            .bind(recoveredSize, new Date().toISOString(), state.taskId)
            .run();
        }
      }
    }
  }
}
