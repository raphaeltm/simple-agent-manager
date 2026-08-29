/**
 * Node-related step handlers for the TaskRunner DO.
 *
 * Handles node_selection, node_provisioning, and node_agent_ready steps,
 * plus node selection helper functions (warm pool, capacity finding, health).
 */
import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import type { CredentialProvider, VMSize } from '@simple-agent-manager/shared';
import { vmSizeFallbackChain } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../services/capacity-placement-snapshot';
import {
  type CapacityPlacementSnapshotRow,
  toCapacityPlacementSnapshot,
} from '../../services/capacity-pools';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  type CapacityAwareNodePlacementRow,
  capacityPoolNoCandidatesError,
  hasNoCapacityPoolCandidates,
  resolveCapacityAwareQuotaCredentialSource,
  resolveReusableNodeCapacitySnapshot,
} from '../../services/placement-resolver';
import {
  assertVmProvisioningLease,
  getVmAdmissionConfig,
  markVmProvisioningLeaseInflightNode,
  recordVmProviderCapacityFailure,
  recordVmProviderCapacitySuccess,
  releaseVmProvisioningLease,
  renewVmProvisioningLease,
  tryAcquireVmProvisioningLease,
  waitForVmAdmissionCapacity,
} from '../../services/vm-admission-control';
import { assertClaimedNodeAvailable } from './claimed-node-availability';
import { parseEnvInt } from './helpers';
import {
  buildAdmissionIdentity,
  handleLeaseResult,
  scheduleAdmissionWait,
} from './node-provisioning-admission';
import { applyCapacityCandidateProvisioningTarget } from './node-provisioning-target';
import {
  findNodeWithCapacity,
  nodeSatisfiesTaskResources,
  releaseClaimedWarmNode,
  type ReusableNodeSelection,
  tryClaimWarmNode,
  verifyNodeAgentHealthy,
} from './node-selection';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export { handleNodeAgentReady } from './node-agent-ready-step';
export { verifyNodeAgentHealthy } from './node-selection';

// =========================================================================
// Step Handlers
// =========================================================================

async function trySelectReusableNodeForProvisioning(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<ReusableNodeSelection | null> {
  const warmNode = await tryClaimWarmNode(state, rc);
  if (warmNode) {
    if (await verifyNodeAgentHealthy(warmNode.nodeId, rc)) {
      return warmNode;
    }
    await releaseClaimedWarmNode(state, rc, warmNode.nodeId);
    log.warn('task_runner_do.node_provisioning.warm_node_unhealthy', {
      taskId: state.taskId,
      nodeId: warmNode.nodeId,
    });
  }

  const existingNode = await findNodeWithCapacity(state, rc);
  if (existingNode) {
    if (await verifyNodeAgentHealthy(existingNode.nodeId, rc)) {
      return existingNode;
    }
    log.warn('task_runner_do.node_provisioning.existing_node_unhealthy', {
      taskId: state.taskId,
      nodeId: existingNode.nodeId,
    });
  }

  return null;
}

export async function handleNodeSelection(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_selection');

  log.info('task_runner_do.step.node_selection', {
    taskId: state.taskId,
    preferredNodeId: state.config.preferredNodeId,
  });

  if (
    state.config.capacityPoolSelection &&
    hasNoCapacityPoolCandidates(state.config.capacityPoolSelection)
  ) {
    throw capacityPoolNoCandidatesError(state.config.capacityPoolSelection);
  }

  if (state.config.preferredNodeId) {
    // Validate the preferred node
    const node = await rc.env.DATABASE.prepare(
      `SELECT
         id,
         status,
         vm_size AS vmSize,
         vm_location AS vmLocation,
         cloud_provider AS cloudProvider,
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
         provider_instance_price_display AS providerInstancePriceDisplay,
         provider_instance_price_currency AS providerInstancePriceCurrency,
         provider_instance_price_monthly_cents AS providerInstancePriceMonthlyCents,
         provider_instance_price_hourly_micros AS providerInstancePriceHourlyMicros,
         placement_explanation_json AS placementExplanationJson,
         agent_version AS agentVersion
       FROM nodes WHERE id = ? AND user_id = ?`
    )
      .bind(state.config.preferredNodeId, state.userId)
      .first<
        | (CapacityAwareNodePlacementRow & {
            id: string;
            status: string;
            agentVersion: string | null;
          })
        | null
      >();

    if (!node || node.status !== 'running') {
      throw Object.assign(new Error('Specified node is not available'), { permanent: true });
    }
    if (!nodeSatisfiesTaskResources(node, state)) {
      throw Object.assign(new Error('Specified node does not satisfy the requested resources'), {
        permanent: true,
      });
    }
    if (!isNodeAgentVersionCompatible(node.agentVersion, rc.env.VM_AGENT_REQUIRED_VERSION)) {
      throw Object.assign(new Error('Specified node is running an incompatible VM agent build'), {
        permanent: true,
      });
    }
    const capacityPlacementSnapshot = resolveReusableNodeCapacitySnapshot({
      selection: state.config.capacityPoolSelection,
      node,
      projectId: state.projectId,
      requestedVmSize: state.config.vmSize,
      requestedReservation: state.config.resolvedReservation ?? null,
    });
    if (capacityPlacementSnapshot === undefined) {
      throw Object.assign(new Error('Specified node is outside the selected capacity pool'), {
        permanent: true,
      });
    }

    // Verify the VM agent is actually reachable before reusing
    if (await verifyNodeAgentHealthy(node.id, rc)) {
      state.stepResults.nodeId = node.id;
      state.stepResults.capacityPlacementSnapshot = capacityPlacementSnapshot;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    log.warn('task_runner_do.preferred_node_unhealthy', {
      taskId: state.taskId,
      nodeId: node.id,
    });
    throw Object.assign(new Error('Specified node is not reachable'), { permanent: true });
  }

  // Try warm pool first
  const warmNode = await tryClaimWarmNode(state, rc);
  if (warmNode) {
    if (await verifyNodeAgentHealthy(warmNode.nodeId, rc)) {
      state.stepResults.nodeId = warmNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = warmNode.capacityPlacementSnapshot;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    await releaseClaimedWarmNode(state, rc, warmNode.nodeId);
    // Warm node agent not healthy — fall through to try other options
    log.warn('task_runner_do.warm_node_unhealthy', {
      taskId: state.taskId,
      nodeId: warmNode.nodeId,
    });
  }

  // Try existing running nodes with capacity
  const existingNode = await findNodeWithCapacity(state, rc);
  if (existingNode) {
    if (await verifyNodeAgentHealthy(existingNode.nodeId, rc)) {
      state.stepResults.nodeId = existingNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = existingNode.capacityPlacementSnapshot;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    // Existing node agent not healthy — fall through to provision
    log.warn('task_runner_do.existing_node_unhealthy', {
      taskId: state.taskId,
      nodeId: existingNode.nodeId,
    });
  }

  // No node found — need to provision
  await rc.advanceToStep(state, 'node_provisioning');
}

export async function handleNodeProvisioning(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_provisioning');
  const requestedSizeBeforeProvisioning: VMSize = state.config.vmSize;

  if (
    state.config.capacityPoolSelection &&
    hasNoCapacityPoolCandidates(state.config.capacityPoolSelection)
  ) {
    throw capacityPoolNoCandidatesError(state.config.capacityPoolSelection);
  }

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

  // If we already created the node (retry scenario, or recovery above), check its status
  if (state.stepResults.nodeId) {
    if (!state.provisioningStartedAt) {
      state.provisioningStartedAt = Date.now();
      await rc.ctx.storage.put('state', state);
    }
    await renewVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken
    );
    const node = await rc.env.DATABASE.prepare(
      `SELECT id, status, error_message FROM nodes WHERE id = ?`
    )
      .bind(state.stepResults.nodeId)
      .first<{ id: string; status: string; error_message: string | null }>();

    await assertClaimedNodeAvailable(state, rc, node, 'node_provisioning');

    // Availability must win over the generic timeout. Otherwise a late poll for
    // a deleted node leaves autoProvisioned=true and failure cleanup may try to
    // return an already-gone resource to the warm pool.
    const timeoutMs = rc.getProvisionTimeoutMs();
    const elapsed = Date.now() - state.provisioningStartedAt;
    if (elapsed > timeoutMs) {
      const minutes = Math.round(timeoutMs / 60_000);
      throw Object.assign(
        new Error(`Node provisioning timed out after ${minutes} minute${minutes === 1 ? '' : 's'}`),
        { permanent: true }
      );
    }

    if (node?.status === 'running') {
      // Already provisioned — advance
      await rc.advanceToStep(state, 'node_agent_ready');
      return;
    }
    if (node?.status === 'error' || node?.status === 'stopped') {
      throw Object.assign(new Error(node.error_message || 'Node provisioning failed'), {
        permanent: true,
      });
    }
    // Still creating — schedule another poll
    await rc.ctx.storage.setAlarm(Date.now() + rc.getProvisionPollIntervalMs());
    return;
  }

  const selectedCapacityCandidate = state.config.capacityPoolSelection?.candidates[0] ?? null;
  if (selectedCapacityCandidate) {
    applyCapacityCandidateProvisioningTarget(state, selectedCapacityCandidate);
  }

  const admissionIdentity = await buildAdmissionIdentity(state, rc);

  // A waiter woken by capacity changes should try packing onto an existing
  // compatible node before claiming the provisioning lease.
  if (admissionIdentity) {
    const reusableNode = await trySelectReusableNodeForProvisioning(state, rc);
    if (reusableNode) {
      state.stepResults.nodeId = reusableNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = reusableNode.capacityPlacementSnapshot;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
  }

  // Check user node limit. User-owned (BYO) nodes are excluded — they cost SAM nothing to run, so
  // they must not consume an auto-provisioning slot or block cloud provisioning (critique #8).
  const maxNodes = parseEnvInt(rc.env.MAX_NODES_PER_USER, 10);
  const countResult = await rc.env.DATABASE.prepare(
    `SELECT COUNT(*) as c FROM nodes WHERE user_id = ? AND status IN ('running', 'creating', 'recovery') AND node_role = 'workspace' AND node_class != 'user-owned'`
  )
    .bind(state.userId)
    .first<{ c: number }>();

  if ((countResult?.c ?? 0) >= maxNodes) {
    if (admissionIdentity && getVmAdmissionConfig(rc.env).mode === 'enforce') {
      const waitResult = await waitForVmAdmissionCapacity(
        rc.env,
        admissionIdentity,
        'user_node_limit'
      );
      if (waitResult.kind === 'expired') {
        throw Object.assign(
          new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`),
          {
            permanent: true,
          }
        );
      }
      await scheduleAdmissionWait(state, rc, waitResult);
      return;
    }
    throw Object.assign(new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`), {
      permanent: true,
    });
  }

  // Re-check quota before provisioning (hard gate for platform compute).
  // Resolves credential source for the target provider — not just whether the user
  // has ANY cloud credential. A user with a Hetzner credential who provisions on
  // Scaleway (platform) must still be quota-enforced.
  const quotaEnforcementEnabled = rc.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
  if (quotaEnforcementEnabled) {
    const { drizzle } = await import('drizzle-orm/d1');
    const drizzleSchema = await import('../../db/schema');
    const db = drizzle(rc.env.DATABASE, { schema: drizzleSchema });
    const { resolveCredentialSource } = await import('../../services/provider-credentials');
    const attributionProjectId =
      state.config.credentialAttributionSource === 'project'
        ? state.config.credentialAttributionProjectId
        : null;
    const credResult = await resolveCredentialSource(
      db,
      state.config.credentialAttributionUserId,
      (state.config.cloudProvider as CredentialProvider) ?? undefined,
      attributionProjectId
    );

    if (!credResult) {
      throw Object.assign(new Error('No cloud provider credentials available for provisioning.'), {
        permanent: true,
      });
    }

    const quotaCredentialSource = resolveCapacityAwareQuotaCredentialSource(
      credResult,
      state.config.capacityPoolSelection ?? null
    );
    if (quotaCredentialSource === 'platform') {
      const { checkQuotaForUser } = await import('../../services/compute-quotas');
      const quotaCheck = await checkQuotaForUser(db, state.userId);

      if (!quotaCheck.allowed) {
        throw Object.assign(
          new Error(
            `Monthly compute quota exceeded: ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours used. ` +
              'Add your own cloud provider credentials or contact your admin.'
          ),
          { permanent: true }
        );
      }
    }
  }

  if (admissionIdentity) {
    const leaseResult = await tryAcquireVmProvisioningLease(rc.env, admissionIdentity);
    if ((await handleLeaseResult(state, rc, leaseResult)) === 'waiting') return;

    // Re-select after winning the claim. A compatible node may have become
    // reusable while this task was competing for the fenced provisioning lease.
    const reusableNode = await trySelectReusableNodeForProvisioning(state, rc);
    if (reusableNode) {
      await releaseVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken,
        'claim_reselected_existing_node'
      );
      state.admissionScopeKey = null;
      state.admissionLeaseToken = null;
      state.stepResults.nodeId = reusableNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = reusableNode.capacityPlacementSnapshot;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
  }

  // Import and call node creation services
  // We import dynamically to avoid circular dependency issues and
  // to keep the DO module lighter
  const { createNodeRecord, provisionNode } = await import('../../services/nodes');
  const { getRuntimeLimits } = await import('../../services/limits');
  const limits = getRuntimeLimits(rc.env);

  // Size-fallback descent (only when the size is default-derived — i.e. nobody
  // asked for a specific size). When provisioning a brand-new node fails with a
  // transient_capacity error, drop to the next-smaller size and retry, descending
  // to the smallest. An explicit size requirement (task/trigger/agent-profile)
  // never downgrades — it fails with a clear message. See
  // tasks/active/2026-06-04-vm-size-fallback-on-capacity.md.
  const fallbackEnabled = rc.env.CAPACITY_SIZE_FALLBACK_ENABLED !== 'false';
  const sizeIsDefaultDerived =
    state.config.vmSizeSource === 'project' || state.config.vmSizeSource === 'platform';
  const fallbackAllowed = fallbackEnabled && sizeIsDefaultDerived;
  let chain: VMSize[];
  if (selectedCapacityCandidate) {
    chain = [selectedCapacityCandidate.machineSize ?? requestedSizeBeforeProvisioning];
  } else if (fallbackAllowed) {
    chain = vmSizeFallbackChain(requestedSizeBeforeProvisioning);
  } else {
    chain = [requestedSizeBeforeProvisioning];
  }

  for (const [i, size] of chain.entries()) {
    const isLastSize = i === chain.length - 1;

    // Quota and credential resolution above can take long enough for the
    // source parent to terminalize. Revalidate at the allocation boundary.
    await rc.assertRecoveryAuthority(state);
    await assertVmProvisioningLease(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken
    );
    state.provisioningStartedAt = Date.now();
    const createdNode = await createNodeRecord(rc.env, {
      userId: state.userId,
      credentialAttributionUserId: state.config.credentialAttributionUserId,
      credentialAttributionProjectId: state.config.credentialAttributionProjectId,
      credentialAttributionSource: state.config.credentialAttributionSource,
      name: `Auto: ${state.config.taskTitle.slice(0, 40)}`,
      vmSize: size,
      vmLocation: state.config.vmLocation,
      heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
      cloudProvider: state.config.cloudProvider ?? undefined,
      providerInstanceType: state.config.providerInstanceType ?? null,
      capacityPlacementSnapshot: state.stepResults.capacityPlacementSnapshot ?? null,
    });

    // Store autoProvisionedNodeId on the task
    await rc.env.DATABASE.prepare(
      `UPDATE tasks
       SET auto_provisioned_node_id = ?, ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS}, updated_at = ?
       WHERE id = ?`
    )
      .bind(
        createdNode.id,
        ...capacityPlacementSnapshotSqlValues(state.stepResults.capacityPlacementSnapshot),
        new Date().toISOString(),
        state.taskId
      )
      .run();

    // Persist ownership before the provider call so a revocation or crash
    // after record creation still drives ordinary resource cleanup.
    state.stepResults.nodeId = createdNode.id;
    state.stepResults.autoProvisioned = true;
    state.stepResults.provisionedVmSize = size;
    await rc.ctx.storage.put('state', state);
    const markedInflight = await markVmProvisioningLeaseInflightNode(
      rc.env,
      state.admissionScopeKey,
      state.taskId,
      state.admissionLeaseToken,
      createdNode.id
    );
    if (state.admissionScopeKey && state.admissionLeaseToken && !markedInflight) {
      throw Object.assign(new Error('VM provisioning lease lost before provider allocation'), {
        permanent: true,
      });
    }

    log.info('task_runner_do.step.node_provisioning', {
      taskId: state.taskId,
      nodeId: createdNode.id,
      vmSize: size,
      requestedVmSize: requestedSizeBeforeProvisioning,
      attempt: i + 1,
      chainLength: chain.length,
      capacityPoolId: state.stepResults.capacityPlacementSnapshot?.capacityPoolId ?? null,
      capacitySourceId: state.stepResults.capacityPlacementSnapshot?.capacitySourceId ?? null,
      capacityPoolCandidateId:
        state.stepResults.capacityPlacementSnapshot?.capacityPoolCandidateId ?? null,
    });

    try {
      // Provision the node with task context so the VM agent enables
      // the message reporter for chat persistence. rethrowProviderError makes
      // provisionNode surface the typed ProviderError (and delete the failed
      // node row on capacity exhaustion) so we can branch on the category.
      await rc.assertRecoveryAuthority(state);
      await provisionNode(
        createdNode.id,
        rc.env,
        {
          projectId: state.projectId,
          chatSessionId: state.stepResults.chatSessionId ?? '',
          taskId: state.taskId,
          taskMode: state.config.taskMode,
        },
        {
          rethrowProviderError: true,
          assertExternalMutationAuthority: async () => {
            await rc.assertRecoveryAuthority(state);
            await assertVmProvisioningLease(
              rc.env,
              state.admissionScopeKey,
              state.taskId,
              state.admissionLeaseToken
            );
          },
        }
      );
      // Detect revocation that raced the provider request. The persisted node
      // identity above lets failTask tear the new compute down safely.
      await rc.assertRecoveryAuthority(state);
      await assertVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken
      );
    } catch (err) {
      if (admissionIdentity) {
        const providerCapacity = await recordVmProviderCapacityFailure(rc.env, {
          scope: admissionIdentity,
          error: err,
        });
        if (providerCapacity) {
          await rc.env.DATABASE.prepare(
            `DELETE FROM nodes WHERE id = ? AND provider_instance_id IS NULL`
          )
            .bind(createdNode.id)
            .run();
          await rc.env.DATABASE.prepare(
            `UPDATE tasks SET auto_provisioned_node_id = NULL, updated_at = ? WHERE id = ?`
          )
            .bind(new Date().toISOString(), state.taskId)
            .run();
          state.stepResults.nodeId = null;
          state.stepResults.autoProvisioned = false;
          state.stepResults.provisionedVmSize = null;
          await releaseVmProvisioningLease(
            rc.env,
            state.admissionScopeKey,
            state.taskId,
            state.admissionLeaseToken,
            'provider_account_capacity'
          );
          state.admissionScopeKey = null;
          state.admissionLeaseToken = null;
          await rc.ctx.storage.put('state', state);
          const retryAt = new Date(
            Date.now() + getVmAdmissionConfig(rc.env).providerCooldownMs
          ).toISOString();
          const waitResult = await waitForVmAdmissionCapacity(
            rc.env,
            admissionIdentity,
            'provider_account_capacity',
            retryAt,
            providerCapacity
          );
          if (waitResult.kind === 'expired') {
            throw Object.assign(new Error('Timed out waiting for provider account capacity'), {
              permanent: true,
            });
          }
          await scheduleAdmissionWait(state, rc, waitResult);
          return;
        }
      }
      const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);

      // Any non-capacity provider failure fails fast — never descend on
      // invalid_config / quota_exceeded / auth_error / rate_limited / unknown.
      if (!isCapacityFailure) {
        await releaseVmProvisioningLease(
          rc.env,
          state.admissionScopeKey,
          state.taskId,
          state.admissionLeaseToken,
          'provisioning_failed'
        );
        state.admissionScopeKey = null;
        state.admissionLeaseToken = null;
        await rc.ctx.storage.put('state', state);
        const message = err instanceof Error ? err.message : 'Node provisioning failed';
        throw Object.assign(new Error(message), { permanent: true });
      }

      // transient_capacity: descend to the next-smaller size if one remains.
      // The failed node row was already deleted inside provisionNode (decision #1).
      state.stepResults.nodeId = null;
      state.stepResults.autoProvisioned = false;
      state.stepResults.provisionedVmSize = null;
      await rc.ctx.storage.put('state', state);
      if (!isLastSize) {
        const nextSize = chain[i + 1];
        if (nextSize === undefined) {
          throw Object.assign(
            new Error('Internal error: VM size fallback chain index out of range'),
            { permanent: true }
          );
        }
        log.info('task_runner_do.size_fallback', {
          taskId: state.taskId,
          fromVmSize: size,
          toVmSize: nextSize,
          requestedVmSize: requestedSizeBeforeProvisioning,
          providerCode: err instanceof ProviderError ? err.providerCode : undefined,
        });
        continue;
      }

      // Capacity exhausted at the last size in the chain — terminal.
      const terminalMessage =
        chain.length === 1
          ? `There were no ${size} machines available.`
          : `No capacity for any available VM size (tried ${chain.join(', ')}).`;
      await releaseVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken,
        'transient_capacity_exhausted'
      );
      state.admissionScopeKey = null;
      state.admissionLeaseToken = null;
      await rc.ctx.storage.put('state', state);
      throw Object.assign(new Error(terminalMessage), { permanent: true });
    }

    // provisionNode returned without throwing — this size was accepted.
    // Update the working size so downstream steps reference the size actually
    // provisioned (relevant when we descended below the requested size).
    state.config.vmSize = size;
    await rc.ctx.storage.put('state', state);
    if (admissionIdentity) {
      await recordVmProviderCapacitySuccess(rc.env, admissionIdentity);
    }

    if (size !== requestedSizeBeforeProvisioning) {
      // Persist the downgraded size on the task so the UI can surface it.
      await rc.env.DATABASE.prepare(
        `UPDATE tasks SET provisioned_vm_size = ?, updated_at = ? WHERE id = ?`
      )
        .bind(size, new Date().toISOString(), state.taskId)
        .run();
    }

    // Verify it's running. Async-IP providers (e.g. Scaleway) return with
    // status 'creating' — the non-permanent throw drives the alarm poll-resume
    // loop (handled by the nodeId-set branch at the top of this function).
    const provisionedNode = await rc.env.DATABASE.prepare(
      `SELECT status, error_message FROM nodes WHERE id = ?`
    )
      .bind(createdNode.id)
      .first<{ status: string; error_message: string | null }>();

    if (!provisionedNode || provisionedNode.status !== 'running') {
      throw new Error(provisionedNode?.error_message || 'Node provisioning failed');
    }

    await rc.advanceToStep(state, 'node_agent_ready');
    return;
  }
}
