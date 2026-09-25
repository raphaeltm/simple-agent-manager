/**
 * The `node_provisioning` step handler for the TaskRunner DO.
 *
 * Split out of `node-steps.ts` (rule 18): capacity-exhaustion handling, the VM
 * admission lease and the provider allocation loop are a single concern that is
 * independently reviewable from node SELECTION, which stays in `node-steps.ts`.
 * Crash-recovery adoption, the pre-allocation gates and provider-failure handling
 * live in the sibling `node-provisioning-*` modules.
 */
import type { PlacementAttemptDiagnostic, VMSize } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../services/capacity-placement-snapshot';
import {
  capacityPoolNoCandidatesError,
  hasNoCapacityPoolCandidates,
} from '../../services/placement-resolver';
import {
  assertVmProvisioningLease,
  markVmProvisioningLeaseInflightNode,
  recordVmProviderCapacitySuccess,
  releaseVmProvisioningLease,
  renewVmProvisioningLease,
  tryAcquireVmProvisioningLease,
} from '../../services/vm-admission-control';
import {
  countActiveManagedPoolNodes,
  effectiveCapacityPoolMaxNodes,
  shouldProvisionSpreadNode,
} from './capacity-pool-node-limit';
import { assertClaimedNodeAvailable } from './claimed-node-availability';
import {
  buildAdmissionIdentity,
  handleLeaseResult,
  waitOrThrowForCapacityPoolNodeLimit,
} from './node-provisioning-admission';
import { coreQuotaExclusionReason, type CoreQuotaRejection } from './node-provisioning-core-quota';
import { buildProvisioningExhaustionPlan } from './node-provisioning-exhaustion';
import { handleProvisioningAttemptFailure } from './node-provisioning-failure';
import { enforceComputeQuota, enforceUserNodeLimit } from './node-provisioning-gates';
import { rankProvisioningCandidates } from './node-provisioning-ranking';
import { adoptProvisionedNodeAfterCrash } from './node-provisioning-recovery';
import {
  discardProviderRejectedNode,
  recordProviderRejectedNode,
} from './node-provisioning-rejected-node';
import { trySelectReusableNodeForProvisioning } from './node-provisioning-reuse';
import { applyCapacityCandidateProvisioningTarget } from './node-provisioning-target';
import { persistPlacementDiagnostics } from './placement-diagnostics';
import type { TaskRunnerContext, TaskRunnerState } from './types';

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

  if (state.stepResults.providerRejectedNodeId) {
    await discardProviderRejectedNode(state, rc, state.stepResults.providerRejectedNodeId);
  }
  await adoptProvisionedNodeAfterCrash(state, rc);

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

  // Re-rank the resolver's candidates against the caller's LIVE host
  // distribution. `pack` and `spread` are unobservable on a brand-new offering
  // considered alone — neither utilization nor co-tenancy exists yet — so the
  // resolver could not express them. An absent inventory is a strict no-op, so
  // `balanced`/`smallest-fit` keep the resolver's exact ordering.
  const rankedCapacityCandidates = await rankProvisioningCandidates(state, rc);
  const selectedCapacityCandidate = rankedCapacityCandidates[0] ?? null;
  if (selectedCapacityCandidate) {
    applyCapacityCandidateProvisioningTarget(state, selectedCapacityCandidate);
  }

  const admissionIdentity = await buildAdmissionIdentity(state, rc);
  const spreadNeedsNode = await shouldProvisionSpreadNode(state, rc);

  // A waiter woken by capacity changes should try packing onto an existing
  // compatible node before claiming the provisioning lease.
  if (admissionIdentity && !spreadNeedsNode) {
    const reusableNode = await trySelectReusableNodeForProvisioning(state, rc);
    if (reusableNode) {
      state.stepResults.nodeId = reusableNode.nodeId;
      state.stepResults.capacityPlacementSnapshot = reusableNode.capacityPlacementSnapshot;
      await persistPlacementDiagnostics(state, rc, { queue: {} });
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
  }

  const poolNodeCount = await countActiveManagedPoolNodes(state, rc);
  const poolMaxNodes = effectiveCapacityPoolMaxNodes(state);
  if (poolNodeCount !== null && poolMaxNodes !== null && poolNodeCount >= poolMaxNodes) {
    await waitOrThrowForCapacityPoolNodeLimit(state, rc, admissionIdentity, poolMaxNodes);
    return;
  }

  if ((await enforceUserNodeLimit(state, rc, admissionIdentity)) === 'waiting') return;

  await enforceComputeQuota(state, rc);

  if (admissionIdentity) {
    const leaseResult = await tryAcquireVmProvisioningLease(rc.env, admissionIdentity);
    if ((await handleLeaseResult(state, rc, leaseResult)) === 'waiting') return;

    // Re-select after winning the claim. A compatible node may have become
    // reusable while this task was competing for the fenced provisioning lease.
    // Spread still provisions while below its pool limit; once another lease
    // holder reaches the limit, it switches to ordinary reuse before allocating.
    const spreadNeedsNodeAfterLease = await shouldProvisionSpreadNode(state, rc);
    if (!spreadNeedsNodeAfterLease) {
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
        await persistPlacementDiagnostics(state, rc, { queue: {} });
        await rc.advanceToStep(state, 'workspace_creation');
        return;
      }
    }

    // The provisioning lease serializes the final pool-count check. Without
    // this fence, two tasks that both observed maxNodes - 1 could over-provision.
    const poolNodeCountAfterLease = await countActiveManagedPoolNodes(state, rc);
    const poolMaxNodesAfterLease = effectiveCapacityPoolMaxNodes(state);
    if (
      poolNodeCountAfterLease !== null &&
      poolMaxNodesAfterLease !== null &&
      poolNodeCountAfterLease >= poolMaxNodesAfterLease
    ) {
      await releaseVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken,
        'capacity_pool_node_limit'
      );
      state.admissionScopeKey = null;
      state.admissionLeaseToken = null;
      await waitOrThrowForCapacityPoolNodeLimit(
        state,
        rc,
        admissionIdentity,
        poolMaxNodesAfterLease
      );
      return;
    }
  }

  // Import and call node creation services
  // We import dynamically to avoid circular dependency issues and
  // to keep the DO module lighter
  const { createNodeRecord, provisionNode } = await import('../../services/nodes');
  const { getRuntimeLimits } = await import('../../services/limits');
  const limits = getRuntimeLimits(rc.env);

  // Capacity exhaustion is decided by the effective pool's own exhaustionPolicy
  // (queue / fail / fallback-chain), not by descending the legacy VM-size ladder.
  // The old descent silently provisioned SMALLER hardware than the resolved
  // requirements asked for whenever the size happened to be default-derived.
  const exhaustionPlan = buildProvisioningExhaustionPlan(state, rankedCapacityCandidates);
  if (exhaustionPlan.diagnostics.length > 0) {
    log.info('task_runner_do.node_provisioning.exhaustion_alternatives_excluded', {
      taskId: state.taskId,
      policy: exhaustionPlan.policy,
      excluded: exhaustionPlan.diagnostics.slice(0, 5),
    });
  }

  const diagnosticAttempts: PlacementAttemptDiagnostic[] = exhaustionPlan.attempts.map(
    (attempt, index) => ({
      order: index + 1,
      provider: attempt.provider,
      location: attempt.location,
      providerInstanceType: attempt.providerInstanceType,
      outcome: 'not-attempted',
      reason: null,
    })
  );
  await persistPlacementDiagnostics(state, rc, { attempts: diagnosticAttempts, queue: {} });

  // Offerings an account core quota has already ruled out, filled in by the failure
  // handler. Skipped attempts keep `not-attempted`, with the handler's reason.
  const coreQuotaRejections: CoreQuotaRejection[] = [];
  for (const [i, attempt] of exhaustionPlan.attempts.entries()) {
    const diagnosticAttempt = diagnosticAttempts[i];
    if (!diagnosticAttempt) throw new Error('Missing provisioning attempt diagnostic');
    if (coreQuotaExclusionReason(attempt, coreQuotaRejections)) continue;
    diagnosticAttempt.outcome = 'pending';
    await persistPlacementDiagnostics(state, rc, { attempts: diagnosticAttempts });
    const size = attempt.vmSize;
    // Every attempt after the first re-points the provisioning target at that
    // candidate's own offering, so the provider payload matches the attempt.
    if (i > 0 && attempt.candidate) {
      applyCapacityCandidateProvisioningTarget(state, attempt.candidate);
      await rc.ctx.storage.put('state', state);
    }

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
    let createdNode;
    try {
      createdNode = await createNodeRecord(rc.env, {
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
        providerInstanceBootDiskSizeGb: state.config.providerInstanceBootDiskSizeGb ?? null,
        providerInstanceImage: state.config.providerInstanceImage ?? null,
        providerInstanceArchitecture: state.config.providerInstanceArchitecture ?? null,
        capacityPlacementSnapshot: state.stepResults.capacityPlacementSnapshot ?? null,
      });
    } catch (error) {
      if (
        !(error instanceof Error && error.name === 'CapacityPoolNodeLimitExceededError') ||
        poolMaxNodes === null
      ) {
        throw error;
      }
      await releaseVmProvisioningLease(
        rc.env,
        state.admissionScopeKey,
        state.taskId,
        state.admissionLeaseToken,
        'capacity_pool_node_limit'
      );
      state.admissionScopeKey = null;
      state.admissionLeaseToken = null;
      await rc.ctx.storage.put('state', state);
      await waitOrThrowForCapacityPoolNodeLimit(state, rc, admissionIdentity, poolMaxNodes);
      return;
    }

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
      attemptCount: exhaustionPlan.attempts.length,
      exhaustionPolicy: exhaustionPlan.policy,
      providerInstanceType: attempt.providerInstanceType,
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
          beforeRejectedNodeDelete: () => recordProviderRejectedNode(state, rc, createdNode.id),
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
      if (state.stepResults.providerRejectedNodeId) {
        await discardProviderRejectedNode(state, rc, state.stepResults.providerRejectedNodeId);
      }
      const outcome = await handleProvisioningAttemptFailure(state, rc, {
        err,
        i,
        exhaustionPlan,
        diagnosticAttempts,
        admissionIdentity,
        createdNode,
        coreQuotaRejections,
      });
      if (outcome === 'next-attempt') continue;
      return;
    }

    diagnosticAttempt.outcome = 'succeeded';
    diagnosticAttempt.reason = null;
    await persistPlacementDiagnostics(state, rc, { attempts: diagnosticAttempts, queue: {} });

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
