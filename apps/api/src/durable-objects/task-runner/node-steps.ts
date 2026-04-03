/**
 * Node-related step handlers for the TaskRunner DO.
 *
 * Handles node_selection, node_provisioning, and node_agent_ready steps,
 * plus node selection helper functions (warm pool, capacity finding, health).
 */
import {
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import type { NodeLifecycle } from '../node-lifecycle';
import { parseEnvInt } from './helpers';
import type { TaskRunnerContext, TaskRunnerState } from './types';

// =========================================================================
// Step Handlers
// =========================================================================

export async function handleNodeSelection(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_selection');

  log.info('task_runner_do.step.node_selection', {
    taskId: state.taskId,
    preferredNodeId: state.config.preferredNodeId,
  });

  if (state.config.preferredNodeId) {
    // Validate the preferred node
    const node = await rc.env.DATABASE.prepare(
      `SELECT id, status FROM nodes WHERE id = ? AND user_id = ?`
    ).bind(state.config.preferredNodeId, state.userId).first<{ id: string; status: string }>();

    if (!node || node.status !== 'running') {
      throw Object.assign(new Error('Specified node is not available'), { permanent: true });
    }

    // Verify the VM agent is actually reachable before reusing
    if (await verifyNodeAgentHealthy(node.id, rc)) {
      state.stepResults.nodeId = node.id;
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
  const nodeId = await tryClaimWarmNode(state, rc);
  if (nodeId) {
    if (await verifyNodeAgentHealthy(nodeId, rc)) {
      state.stepResults.nodeId = nodeId;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    // Warm node agent not healthy — fall through to try other options
    log.warn('task_runner_do.warm_node_unhealthy', {
      taskId: state.taskId,
      nodeId,
    });
  }

  // Try existing running nodes with capacity
  const existingNodeId = await findNodeWithCapacity(state, rc);
  if (existingNodeId) {
    if (await verifyNodeAgentHealthy(existingNodeId, rc)) {
      state.stepResults.nodeId = existingNodeId;
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }
    // Existing node agent not healthy — fall through to provision
    log.warn('task_runner_do.existing_node_unhealthy', {
      taskId: state.taskId,
      nodeId: existingNodeId,
    });
  }

  // No node found — need to provision
  await rc.advanceToStep(state, 'node_provisioning');
}

export async function handleNodeProvisioning(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_provisioning');

  // If we already created the node (retry scenario), check its status
  if (state.stepResults.nodeId) {
    const node = await rc.env.DATABASE.prepare(
      `SELECT id, status, error_message FROM nodes WHERE id = ?`
    ).bind(state.stepResults.nodeId).first<{ id: string; status: string; error_message: string | null }>();

    if (node?.status === 'running') {
      // Already provisioned — advance
      await rc.advanceToStep(state, 'node_agent_ready');
      return;
    }
    if (node?.status === 'error' || node?.status === 'stopped') {
      throw new Error(node.error_message || 'Node provisioning failed');
    }
    // Still creating — schedule another poll
    await rc.ctx.storage.setAlarm(
      Date.now() + rc.getProvisionPollIntervalMs()
    );
    return;
  }

  // Check user node limit
  const maxNodes = parseEnvInt(rc.env.MAX_NODES_PER_USER, 10);
  const countResult = await rc.env.DATABASE.prepare(
    `SELECT COUNT(*) as c FROM nodes WHERE user_id = ? AND status IN ('running', 'creating', 'recovery')`
  ).bind(state.userId).first<{ c: number }>();

  if ((countResult?.c ?? 0) >= maxNodes) {
    throw Object.assign(
      new Error(`Maximum ${maxNodes} nodes allowed. Cannot auto-provision.`),
      { permanent: true },
    );
  }

  // Import and call node creation services
  // We import dynamically to avoid circular dependency issues and
  // to keep the DO module lighter
  const { createNodeRecord, provisionNode } = await import('../../services/nodes');
  const { getRuntimeLimits } = await import('../../services/limits');
  const limits = getRuntimeLimits(rc.env);

  const createdNode = await createNodeRecord(rc.env, {
    userId: state.userId,
    name: `Auto: ${state.config.taskTitle.slice(0, 40)}`,
    vmSize: state.config.vmSize,
    vmLocation: state.config.vmLocation,
    heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
    cloudProvider: state.config.cloudProvider ?? undefined,
  });

  state.stepResults.nodeId = createdNode.id;
  state.stepResults.autoProvisioned = true;

  // Store autoProvisionedNodeId on the task
  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET auto_provisioned_node_id = ?, updated_at = ? WHERE id = ?`
  ).bind(createdNode.id, new Date().toISOString(), state.taskId).run();

  await rc.ctx.storage.put('state', state);

  log.info('task_runner_do.step.node_provisioning', {
    taskId: state.taskId,
    nodeId: createdNode.id,
    vmSize: state.config.vmSize,
  });

  // Provision the node with task context so the VM agent enables
  // the message reporter for chat persistence (Bug fix: previously
  // projectId/chatSessionId were empty, disabling the reporter).
  await provisionNode(createdNode.id, rc.env, {
    projectId: state.projectId,
    chatSessionId: state.stepResults.chatSessionId ?? '',
    taskId: state.taskId,
    taskMode: state.config.taskMode,
  });

  // Verify it's running
  const provisionedNode = await rc.env.DATABASE.prepare(
    `SELECT status, error_message FROM nodes WHERE id = ?`
  ).bind(createdNode.id).first<{ status: string; error_message: string | null }>();

  if (!provisionedNode || provisionedNode.status !== 'running') {
    throw new Error(provisionedNode?.error_message || 'Node provisioning failed');
  }

  await rc.advanceToStep(state, 'node_agent_ready');
}

export async function handleNodeAgentReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
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

  // Check timeout
  const timeoutMs = rc.getAgentReadyTimeoutMs();
  const elapsed = Date.now() - state.agentReadyStartedAt;
  if (elapsed > timeoutMs) {
    throw Object.assign(
      new Error(`Node agent not ready within ${timeoutMs}ms`),
      { permanent: true },
    );
  }

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
    `SELECT health_status, last_heartbeat_at, status FROM nodes WHERE id = ?`
  ).bind(state.stepResults.nodeId).first<{
    health_status: string | null;
    last_heartbeat_at: string | null;
    status: string;
  }>();

  if (node?.health_status === 'healthy' && node.last_heartbeat_at) {
    // Verify the heartbeat is recent (not stale from a previous boot)
    const heartbeatTime = new Date(node.last_heartbeat_at).getTime();
    const heartbeatIsRecent = heartbeatTime > (state.agentReadyStartedAt! - 30_000);

    if (heartbeatIsRecent) {
      log.info('task_runner_do.step.node_agent_ready', {
        taskId: state.taskId,
        nodeId: state.stepResults.nodeId,
        elapsedMs: elapsed,
        lastHeartbeatAt: node.last_heartbeat_at,
      });
      await rc.advanceToStep(state, 'workspace_creation');
      return;
    }

    log.info('task_runner_do.step.node_agent_ready.stale_heartbeat', {
      taskId: state.taskId,
      nodeId: state.stepResults.nodeId,
      elapsedMs: elapsed,
      lastHeartbeatAt: node.last_heartbeat_at,
      agentReadyStartedAt: new Date(state.agentReadyStartedAt!).toISOString(),
      message: 'Node has heartbeat but it predates this provisioning cycle',
    });
  }

  // Not ready — schedule another poll
  await rc.ctx.storage.setAlarm(Date.now() + rc.getAgentPollIntervalMs());
}

// =========================================================================
// Node selection helpers
// =========================================================================

/**
 * Verify that the VM agent on a node is actually healthy by checking D1
 * heartbeat records. We cannot fetch the VM directly because Cloudflare
 * same-zone routing intercepts Worker subrequests to vm-* hostnames,
 * routing them back to this API Worker instead of the VM agent.
 */
export async function verifyNodeAgentHealthy(
  nodeId: string,
  rc: TaskRunnerContext,
): Promise<boolean> {
  try {
    const node = await rc.env.DATABASE.prepare(
      `SELECT health_status, last_heartbeat_at FROM nodes WHERE id = ?`
    ).bind(nodeId).first<{
      health_status: string | null;
      last_heartbeat_at: string | null;
    }>();

    if (!node || node.health_status !== 'healthy' || !node.last_heartbeat_at) {
      return false;
    }

    // Consider node healthy if heartbeat is within the stale threshold
    const staleSeconds = parseInt(rc.env.NODE_HEARTBEAT_STALE_SECONDS || '180', 10);
    const heartbeatAge = (Date.now() - new Date(node.last_heartbeat_at).getTime()) / 1000;
    return heartbeatAge < staleSeconds;
  } catch {
    return false;
  }
}

async function tryClaimWarmNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<string | null> {
  if (!rc.env.NODE_LIFECYCLE) return null;

  const warmNodes = await rc.env.DATABASE.prepare(
    `SELECT id, vm_size, vm_location FROM nodes
     WHERE user_id = ? AND status = 'running' AND warm_since IS NOT NULL`
  ).bind(state.userId).all<{ id: string; vm_size: string; vm_location: string }>();

  if (!warmNodes.results.length) return null;

  // Sort: prefer matching size/location
  const sorted = warmNodes.results.sort((a, b) => {
    const aSizeMatch = a.vm_size === state.config.vmSize ? 1 : 0;
    const bSizeMatch = b.vm_size === state.config.vmSize ? 1 : 0;
    if (aSizeMatch !== bSizeMatch) return bSizeMatch - aSizeMatch;
    const aLocMatch = a.vm_location === state.config.vmLocation ? 1 : 0;
    const bLocMatch = b.vm_location === state.config.vmLocation ? 1 : 0;
    return bLocMatch - aLocMatch;
  });

  for (const warmNode of sorted) {
    try {
      // Re-check freshness
      const fresh = await rc.env.DATABASE.prepare(
        `SELECT status, warm_since FROM nodes WHERE id = ? AND status = 'running' AND warm_since IS NOT NULL`
      ).bind(warmNode.id).first<{ status: string; warm_since: string | null }>();

      if (!fresh) continue;

      // Try to claim via NodeLifecycle DO
      const doId = rc.env.NODE_LIFECYCLE.idFromName(warmNode.id);
      const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
      const result = await stub.tryClaim(state.taskId) as { claimed: boolean };

      if (result.claimed) {
        // Defense-in-depth: verify workspace count even for warm nodes
        const wsCount = await rc.env.DATABASE.prepare(
          `SELECT COUNT(*) as c FROM workspaces WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
        ).bind(warmNode.id).first<{ c: number }>();
        const warmMaxWs = state.config.projectScaling?.maxWorkspacesPerNode
          ?? parseEnvInt(rc.env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE);
        if ((wsCount?.c ?? 0) >= warmMaxWs) {
          continue; // At capacity despite being warm — skip
        }
        log.info('task_runner_do.warm_node_claimed', {
          taskId: state.taskId,
          nodeId: warmNode.id,
        });
        return warmNode.id;
      }
    } catch {
      // Claim failed — try next
    }
  }

  return null;
}

async function findNodeWithCapacity(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<string | null> {
  const scaling = state.config.projectScaling;
  const cpuThreshold = scaling?.nodeCpuThresholdPercent
    ?? parseEnvInt(rc.env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT, DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT);
  const memThreshold = scaling?.nodeMemoryThresholdPercent
    ?? parseEnvInt(rc.env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT, DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT);
  const maxWorkspaces = scaling?.maxWorkspacesPerNode
    ?? parseEnvInt(rc.env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE);

  const nodes = await rc.env.DATABASE.prepare(
    `SELECT id, vm_size, vm_location, health_status, last_metrics FROM nodes
     WHERE user_id = ? AND status = 'running' AND health_status != 'unhealthy'`
  ).bind(state.userId).all<{
    id: string;
    vm_size: string;
    vm_location: string;
    health_status: string;
    last_metrics: string | null;
  }>();

  if (!nodes.results.length) return null;

  // Batch workspace count query to avoid N+1 D1 round-trips
  const nodeIds = nodes.results.map(n => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const wsCounts = await rc.env.DATABASE.prepare(
    `SELECT node_id, COUNT(*) as c FROM workspaces
     WHERE node_id IN (${placeholders})
     AND status IN ('running', 'creating', 'recovery')
     GROUP BY node_id`
  ).bind(...nodeIds).all<{ node_id: string; c: number }>();
  const countByNode = new Map((wsCounts.results ?? []).map(r => [r.node_id, r.c]));

  type ScoredNode = {
    id: string;
    vmSize: string;
    vmLocation: string;
    score: number | null;
  };

  const candidates: ScoredNode[] = [];

  for (const node of nodes.results) {
    // Hard workspace count limit — reject node regardless of CPU/memory metrics
    if ((countByNode.get(node.id) ?? 0) >= maxWorkspaces) continue;
    let metrics: { cpuLoadAvg1?: number; memoryPercent?: number } | null = null;
    if (node.last_metrics) {
      try { metrics = JSON.parse(node.last_metrics); } catch { /* ignore */ }
    }

    if (metrics) {
      const cpu = metrics.cpuLoadAvg1 ?? 0;
      const mem = metrics.memoryPercent ?? 0;
      if (cpu >= cpuThreshold || mem >= memThreshold) continue;
      candidates.push({
        id: node.id,
        vmSize: node.vm_size,
        vmLocation: node.vm_location,
        score: cpu * 0.4 + mem * 0.6,
      });
    } else {
      candidates.push({
        id: node.id,
        vmSize: node.vm_size,
        vmLocation: node.vm_location,
        score: null,
      });
    }
  }

  if (!candidates.length) return null;

  // Sort: prefer matching location/size, then lowest load
  candidates.sort((a, b) => {
    const aLoc = a.vmLocation === state.config.vmLocation ? 1 : 0;
    const bLoc = b.vmLocation === state.config.vmLocation ? 1 : 0;
    if (aLoc !== bLoc) return bLoc - aLoc;
    const aSize = a.vmSize === state.config.vmSize ? 1 : 0;
    const bSize = b.vmSize === state.config.vmSize ? 1 : 0;
    if (aSize !== bSize) return bSize - aSize;
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return a.score - b.score;
  });

  return candidates[0]!.id;
}
