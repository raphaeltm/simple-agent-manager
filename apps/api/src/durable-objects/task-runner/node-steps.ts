/**
 * Node-related step handlers for the TaskRunner DO.
 *
 * Handles node_selection, node_provisioning, and node_agent_ready steps,
 * plus node selection helper functions (warm pool, capacity finding, health).
 */
import { isTransientCapacityError, ProviderError } from '@simple-agent-manager/providers';
import type { VMSize } from '@simple-agent-manager/shared';
import { vmSizeFallbackChain } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { selectNodeWithExplanation } from '../../services/node-selector';
import { assertClaimedNodeAvailable } from './claimed-node-availability';
import { persistTaskPlacement, recordProvisioningAttempt } from './placement';
import { assertTaskNodeProvisioningAllowed } from './provisioning-guards';
import { isNodeAgentReadyForWorkspaceDispatch } from './readiness';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export { verifyNodeAgentHealthy } from './node-selection';

// =========================================================================
// Step Handlers
// =========================================================================

export async function handleNodeSelection(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_selection');

  log.info('task_runner_do.step.node_selection', {
    taskId: state.taskId,
    preferredNodeId: state.config.preferredNodeId,
  });

  const scaling = state.config.projectScaling;
  const placement = await selectNodeWithExplanation(
    drizzle(rc.env.DATABASE, { schema }),
    state.userId,
    rc.env,
    {
      vmSize: state.config.vmSize,
      vmLocation: state.config.vmLocation,
      taskId: state.taskId,
      preferredNodeId: state.config.preferredNodeId ?? undefined,
      preferredOnly: Boolean(state.config.preferredNodeId),
      limits: {
        maxWorkspacesPerNode: scaling?.maxWorkspacesPerNode ?? undefined,
        cpuThresholdPercent: scaling?.nodeCpuThresholdPercent ?? undefined,
        memoryThresholdPercent: scaling?.nodeMemoryThresholdPercent ?? undefined,
      },
    }
  );
  await persistTaskPlacement(state, rc, placement.explanation);

  if (placement.node) {
    state.stepResults.nodeId = placement.node.id;
    await rc.advanceToStep(state, 'workspace_creation');
    return;
  }
  if (state.config.preferredNodeId) {
    const reasons = placement.explanation.evaluatedNodes.find(
      (evaluation) => evaluation.nodeId === state.config.preferredNodeId
    )?.rejectionReasons;
    const message = reasons?.includes('undersized')
      ? 'Specified node is smaller than the requested VM size'
      : reasons?.includes('agent-version-mismatch')
        ? 'Specified node is running an incompatible VM agent build'
        : reasons?.some((reason) =>
              ['unhealthy', 'heartbeat-missing', 'heartbeat-stale', 'agent-not-ready'].includes(
                reason
              )
            )
          ? 'Specified node is not reachable'
          : 'Specified node is not available';
    throw Object.assign(new Error(message), { permanent: true });
  }

  await rc.advanceToStep(state, 'node_provisioning');
}

export async function handleNodeProvisioning(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_provisioning');

  // Initialize timeout tracking on first entry (mirrors handleNodeAgentReady pattern)
  if (!state.provisioningStartedAt) {
    state.provisioningStartedAt = Date.now();
    await rc.ctx.storage.put('state', state);
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
        `SELECT id, status, vm_size FROM nodes WHERE id = ?`
      )
        .bind(recoveredNodeId)
        .first<{ id: string; status: string; vm_size: string }>();
      if (
        existing &&
        (existing.status === 'running' ||
          existing.status === 'creating' ||
          existing.status === 'recovery')
      ) {
        const recoveredSize = existing.vm_size as VMSize;
        const requestedBeforeRecovery = state.config.vmSize;
        state.stepResults.nodeId = existing.id;
        state.stepResults.autoProvisioned = true;
        state.stepResults.provisionedVmSize = recoveredSize;
        state.config.vmSize = recoveredSize;
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
      const latestAttempt = state.placementExplanation?.provisioningAttempts.at(-1);
      if (latestAttempt?.outcome === 'started') {
        await recordProvisioningAttempt(
          state,
          rc,
          {
            vmSize: state.config.vmSize,
            vmLocation: state.config.vmLocation,
            outcome: 'succeeded',
          },
          state.stepResults.nodeId
        );
      }
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

  await assertTaskNodeProvisioningAllowed(state, rc);

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
  const requestedSize: VMSize = state.config.vmSize;
  const chain: VMSize[] = fallbackAllowed ? vmSizeFallbackChain(requestedSize) : [requestedSize];

  for (const [i, size] of chain.entries()) {
    const isLastSize = i === chain.length - 1;

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
    });

    // Store autoProvisionedNodeId on the task
    await rc.env.DATABASE.prepare(
      `UPDATE tasks SET auto_provisioned_node_id = ?, updated_at = ? WHERE id = ?`
    )
      .bind(createdNode.id, new Date().toISOString(), state.taskId)
      .run();

    await recordProvisioningAttempt(
      state,
      rc,
      {
        vmSize: size,
        vmLocation: state.config.vmLocation,
        outcome: 'started',
      },
      createdNode.id
    );

    log.info('task_runner_do.step.node_provisioning', {
      taskId: state.taskId,
      nodeId: createdNode.id,
      vmSize: size,
      requestedVmSize: requestedSize,
      attempt: i + 1,
      chainLength: chain.length,
    });

    try {
      // Provision the node with task context so the VM agent enables
      // the message reporter for chat persistence. rethrowProviderError makes
      // provisionNode surface the typed ProviderError (and delete the failed
      // node row on capacity exhaustion) so we can branch on the category.
      await provisionNode(
        createdNode.id,
        rc.env,
        {
          projectId: state.projectId,
          chatSessionId: state.stepResults.chatSessionId ?? '',
          taskId: state.taskId,
          taskMode: state.config.taskMode,
        },
        { rethrowProviderError: true }
      );
    } catch (err) {
      const isCapacityFailure = err instanceof ProviderError && isTransientCapacityError(err);

      // Any non-capacity provider failure fails fast — never descend on
      // invalid_config / quota_exceeded / auth_error / rate_limited / unknown.
      if (!isCapacityFailure) {
        await recordProvisioningAttempt(
          state,
          rc,
          {
            vmSize: size,
            vmLocation: state.config.vmLocation,
            outcome: 'failed',
            failureReason: 'provider-failed',
          },
          createdNode.id
        );
        const message = err instanceof Error ? err.message : 'Node provisioning failed';
        throw Object.assign(new Error(message), { permanent: true });
      }

      // transient_capacity: descend to the next-smaller size if one remains.
      // The failed node row was already deleted inside provisionNode (decision #1).
      if (!isLastSize) {
        await recordProvisioningAttempt(
          state,
          rc,
          {
            vmSize: size,
            vmLocation: state.config.vmLocation,
            outcome: 'capacity-rejected',
            failureReason: 'capacity-unavailable',
          },
          null
        );
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
          requestedVmSize: requestedSize,
          providerCode: err instanceof ProviderError ? err.providerCode : undefined,
        });
        continue;
      }

      // Capacity exhausted at the last size in the chain — terminal.
      const terminalMessage =
        chain.length === 1
          ? `There were no ${requestedSize} machines available.`
          : `No capacity for any available VM size (tried ${chain.join(', ')}).`;
      await recordProvisioningAttempt(
        state,
        rc,
        {
          vmSize: size,
          vmLocation: state.config.vmLocation,
          outcome: 'failed',
          failureReason: 'capacity-unavailable',
        },
        null
      );
      throw Object.assign(new Error(terminalMessage), { permanent: true });
    }

    // provisionNode returned without throwing — this size was accepted.
    state.stepResults.nodeId = createdNode.id;
    state.stepResults.autoProvisioned = true;
    state.stepResults.provisionedVmSize = size;
    // Update the working size so downstream steps reference the size actually
    // provisioned (relevant when we descended below the requested size).
    state.config.vmSize = size;
    await rc.ctx.storage.put('state', state);
    await recordProvisioningAttempt(
      state,
      rc,
      {
        vmSize: size,
        vmLocation: state.config.vmLocation,
        outcome: 'succeeded',
      },
      createdNode.id
    );

    if (size !== requestedSize) {
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

export async function handleNodeAgentReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_agent_ready');

  if (!state.stepResults.nodeId) {
    throw new Error('No nodeId in state — cannot check agent readiness');
  }

  // Initialize timeout tracking on first entry
  if (!state.agentReadyStartedAt) {
    state.agentReadyStartedAt = Date.now();
    await rc.ctx.storage.put('state', state);
  }
  const agentReadyStartedAt = state.agentReadyStartedAt;

  // Check agent health via D1 heartbeat records.
  //
  // IMPORTANT: We do NOT fetch the VM agent directly via its vm-{nodeId} hostname.
  // Cloudflare same-zone routing intercepts Worker subrequests to hostnames matching
  // the wildcard Worker route (*.domain/*), routing them back to the API Worker
  // instead of the VM. The identity verification detects this (the API's /health
  // lacks nodeId), but the request never reaches the actual VM agent.
  //
  // Instead, we check D1 for the node's heartbeat status. The VM agent sends
  // POST /api/nodes/:id/ready on startup and POST /api/nodes/:id/heartbeat
  // periodically, which update healthStatus and lastHeartbeatAt in D1.
  const node = await rc.env.DATABASE.prepare(
    `SELECT health_status, last_heartbeat_at, agent_ready_at, agent_version, status FROM nodes WHERE id = ?`
  )
    .bind(state.stepResults.nodeId)
    .first<{
      health_status: string | null;
      last_heartbeat_at: string | null;
      agent_ready_at: string | null;
      agent_version: string | null;
      status: string;
    }>();

  await assertClaimedNodeAvailable(state, rc, node, 'node_agent_ready');

  // As in provisioning, classify a missing/deleted node before the timeout so
  // failure cleanup cannot attempt to warm a resource that no longer exists.
  const timeoutMs = rc.getAgentReadyTimeoutMs();
  const elapsed = Date.now() - agentReadyStartedAt;
  if (elapsed > timeoutMs) {
    throw Object.assign(new Error(`Node agent not ready within ${timeoutMs}ms`), {
      permanent: true,
    });
  }

  if (
    isNodeAgentReadyForWorkspaceDispatch(
      node,
      agentReadyStartedAt,
      30_000,
      rc.env.VM_AGENT_REQUIRED_VERSION
    )
  ) {
    log.info('task_runner_do.step.node_agent_ready', {
      taskId: state.taskId,
      nodeId: state.stepResults.nodeId,
      elapsedMs: elapsed,
      lastHeartbeatAt: node?.last_heartbeat_at,
      agentReadyAt: node?.agent_ready_at,
    });
    await rc.advanceToStep(state, 'workspace_creation');
    return;
  }

  if (node?.health_status === 'healthy' && node.last_heartbeat_at) {
    log.info('task_runner_do.step.node_agent_ready.stale_heartbeat', {
      taskId: state.taskId,
      nodeId: state.stepResults.nodeId,
      elapsedMs: elapsed,
      lastHeartbeatAt: node.last_heartbeat_at,
      agentReadyAt: node.agent_ready_at,
      agentReadyStartedAt: new Date(agentReadyStartedAt).toISOString(),
      message: 'Node has heartbeat but no fresh /ready signal for this provisioning cycle',
    });
  }

  // Not ready — schedule another poll
  await rc.ctx.storage.setAlarm(Date.now() + rc.getAgentPollIntervalMs());
}
