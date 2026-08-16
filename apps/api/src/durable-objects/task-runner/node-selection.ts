/**
 * Reusable-node health, warm-pool claim, and capacity-selection helpers.
 *
 * Kept separate from the node step handlers so provisioning and placement
 * policy remain independently reviewable. See rule 18.
 */
import {
  canSatisfyVmSize,
  DEFAULT_MAX_WORKSPACES_PER_NODE,
  DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
  DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  SessionRecoveryAuthorityRevokedError,
  type SessionRecoverySourceTaskGuard,
} from '../../services/session-recovery-authority';
import type { NodeLifecycle } from '../node-lifecycle';
import { parseEnvInt } from './helpers';
import type { TaskRunnerContext, TaskRunnerState } from './types';

function recoverySourceTaskGuard(
  state: TaskRunnerState
): SessionRecoverySourceTaskGuard | undefined {
  const taskId = state.config.recoverySourceTaskId ?? null;
  const chatSessionId = state.config.resumeSnapshotChatSessionId ?? null;
  return taskId && chatSessionId
    ? { taskId, projectId: state.projectId, chatSessionId }
    : undefined;
}

export async function releaseClaimedWarmNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string | null = state.stepResults.claimedWarmNodeId ?? null
): Promise<boolean> {
  if (!nodeId || !rc.env.NODE_LIFECYCLE) return false;
  const doId = rc.env.NODE_LIFECYCLE.idFromName(nodeId);
  const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
  const result = await stub.releaseClaim(state.taskId);
  if (result.released || result.state.claimedByTask !== state.taskId) {
    if (state.stepResults.nodeId === nodeId && !state.stepResults.workspaceId) {
      state.stepResults.nodeId = null;
    }
    if (state.stepResults.claimedWarmNodeId === nodeId) {
      state.stepResults.claimedWarmNodeId = null;
    }
    await rc.ctx.storage.put('state', state);
  }
  return result.released;
}

async function claimWarmNodeCandidate(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  nodeId: string
): Promise<boolean> {
  const doId = rc.env.NODE_LIFECYCLE.idFromName(nodeId);
  const stub = rc.env.NODE_LIFECYCLE.get(doId) as DurableObjectStub<NodeLifecycle>;
  await rc.assertRecoveryAuthority(state);
  const result = await stub.tryClaim(state.taskId, recoverySourceTaskGuard(state));
  if (result.reason === 'source_task_revoked') {
    await stub.releaseClaim(state.taskId).catch(() => undefined);
    throw new SessionRecoveryAuthorityRevokedError();
  }
  if (!result.claimed) return false;

  // The DO persisted tasks.claimed_warm_node_id before cancelling its alarm.
  // Mirror the claim into TaskRunner storage immediately for ordinary cleanup.
  state.stepResults.nodeId = nodeId;
  state.stepResults.claimedWarmNodeId = nodeId;
  state.stepResults.autoProvisioned = false;
  await rc.ctx.storage.put('state', state);
  try {
    await rc.assertRecoveryAuthority(state);
  } catch (error) {
    await releaseClaimedWarmNode(state, rc, nodeId).catch(() => undefined);
    throw error;
  }
  return true;
}

/**
 * Verify that the VM agent on a node is actually healthy by checking D1
 * heartbeat records. We cannot fetch the VM directly because Cloudflare
 * same-zone routing intercepts Worker subrequests to vm-* hostnames,
 * routing them back to this API Worker instead of the VM agent.
 */
export async function verifyNodeAgentHealthy(
  nodeId: string,
  rc: TaskRunnerContext
): Promise<boolean> {
  try {
    const node = await rc.env.DATABASE.prepare(
      `SELECT health_status, last_heartbeat_at, agent_ready_at, agent_version FROM nodes WHERE id = ?`
    )
      .bind(nodeId)
      .first<{
        health_status: string | null;
        last_heartbeat_at: string | null;
        agent_ready_at: string | null;
        agent_version: string | null;
      }>();

    if (
      !node ||
      node.health_status !== 'healthy' ||
      !node.last_heartbeat_at ||
      !node.agent_ready_at ||
      !isNodeAgentVersionCompatible(node.agent_version, rc.env.VM_AGENT_REQUIRED_VERSION)
    ) {
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

export async function tryClaimWarmNode(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<string | null> {
  if (!rc.env.NODE_LIFECYCLE) return null;

  // Recover a claim persisted by NodeLifecycle if the TaskRunner crashed after
  // the DO mutation but before its own storage.put.
  const persistedClaim = await rc.env.DATABASE.prepare(
    `SELECT claimed_warm_node_id FROM tasks WHERE id = ?`
  )
    .bind(state.taskId)
    .first<{ claimed_warm_node_id: string | null }>();
  if (persistedClaim?.claimed_warm_node_id) {
    if (await claimWarmNodeCandidate(state, rc, persistedClaim.claimed_warm_node_id)) {
      return persistedClaim.claimed_warm_node_id;
    }
    await rc.env.DATABASE.prepare(
      `UPDATE tasks SET claimed_warm_node_id = NULL, updated_at = ?
        WHERE id = ? AND claimed_warm_node_id = ?`
    )
      .bind(new Date().toISOString(), state.taskId, persistedClaim.claimed_warm_node_id)
      .run();
  }

  const warmNodes = await rc.env.DATABASE.prepare(
    `SELECT id, vm_size, vm_location, agent_version FROM nodes
     WHERE user_id = ? AND status = 'running' AND warm_since IS NOT NULL AND node_role = 'workspace'
       AND (runtime IS NULL OR runtime != 'cf-container')`
  )
    .bind(state.userId)
    .all<{ id: string; vm_size: string; vm_location: string; agent_version: string | null }>();

  if (!warmNodes.results.length) return null;

  // Sort nodes that can satisfy the requested size, preferring exact size/location.
  const sorted = warmNodes.results
    .filter((node) =>
      isNodeAgentVersionCompatible(node.agent_version, rc.env.VM_AGENT_REQUIRED_VERSION)
    )
    .filter((node) => canSatisfyVmSize(node.vm_size, state.config.vmSize))
    .sort((a, b) => {
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
        `SELECT status, warm_since, agent_version FROM nodes WHERE id = ? AND status = 'running' AND warm_since IS NOT NULL`
      )
        .bind(warmNode.id)
        .first<{ status: string; warm_since: string | null; agent_version: string | null }>();

      if (
        !fresh ||
        !isNodeAgentVersionCompatible(fresh.agent_version, rc.env.VM_AGENT_REQUIRED_VERSION)
      ) {
        continue;
      }

      if (await claimWarmNodeCandidate(state, rc, warmNode.id)) {
        // Defense-in-depth: verify workspace count even for warm nodes
        const wsCount = await rc.env.DATABASE.prepare(
          `SELECT COUNT(*) as c FROM workspaces WHERE node_id = ? AND status IN ('running', 'creating', 'recovery')`
        )
          .bind(warmNode.id)
          .first<{ c: number }>();
        const warmMaxWs =
          state.config.projectScaling?.maxWorkspacesPerNode ??
          parseEnvInt(rc.env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE);
        if ((wsCount?.c ?? 0) >= warmMaxWs) {
          await releaseClaimedWarmNode(state, rc, warmNode.id);
          continue; // At capacity despite being warm — skip
        }
        log.info('task_runner_do.warm_node_claimed', {
          taskId: state.taskId,
          nodeId: warmNode.id,
        });
        return warmNode.id;
      }
    } catch (error) {
      if (error instanceof SessionRecoveryAuthorityRevokedError) throw error;
      if (state.stepResults.claimedWarmNodeId === warmNode.id) {
        await releaseClaimedWarmNode(state, rc, warmNode.id).catch(() => undefined);
      }
      // Claim failed — try next
    }
  }

  return null;
}

export async function findNodeWithCapacity(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<string | null> {
  const scaling = state.config.projectScaling;
  const cpuThreshold =
    scaling?.nodeCpuThresholdPercent ??
    parseEnvInt(
      rc.env.TASK_RUN_NODE_CPU_THRESHOLD_PERCENT,
      DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT
    );
  const memThreshold =
    scaling?.nodeMemoryThresholdPercent ??
    parseEnvInt(
      rc.env.TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT,
      DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT
    );
  const maxWorkspaces =
    scaling?.maxWorkspacesPerNode ??
    parseEnvInt(rc.env.MAX_WORKSPACES_PER_NODE, DEFAULT_MAX_WORKSPACES_PER_NODE);

  const nodes = await rc.env.DATABASE.prepare(
    `SELECT id, vm_size, vm_location, health_status, last_metrics, agent_version FROM nodes
     WHERE user_id = ? AND status = 'running' AND health_status != 'unhealthy' AND node_role = 'workspace'
       AND (runtime IS NULL OR runtime != 'cf-container')`
  )
    .bind(state.userId)
    .all<{
      id: string;
      vm_size: string;
      vm_location: string;
      health_status: string;
      last_metrics: string | null;
      agent_version: string | null;
    }>();

  if (!nodes.results.length) return null;

  // Batch workspace count query to avoid N+1 D1 round-trips
  const nodeIds = nodes.results.map((n) => n.id);
  const placeholders = nodeIds.map(() => '?').join(',');
  const wsCounts = await rc.env.DATABASE.prepare(
    `SELECT node_id, COUNT(*) as c FROM workspaces
     WHERE node_id IN (${placeholders})
     AND status IN ('running', 'creating', 'recovery')
     GROUP BY node_id`
  )
    .bind(...nodeIds)
    .all<{ node_id: string; c: number }>();
  const countByNode = new Map((wsCounts.results ?? []).map((r) => [r.node_id, r.c]));

  type ScoredNode = {
    id: string;
    vmSize: string;
    vmLocation: string;
    score: number | null;
  };

  const candidates: ScoredNode[] = [];

  for (const node of nodes.results) {
    if (!isNodeAgentVersionCompatible(node.agent_version, rc.env.VM_AGENT_REQUIRED_VERSION)) {
      continue;
    }
    if (!canSatisfyVmSize(node.vm_size, state.config.vmSize)) continue;

    // Hard workspace count limit — reject node regardless of CPU/memory metrics
    if ((countByNode.get(node.id) ?? 0) >= maxWorkspaces) continue;
    let metrics: { cpuLoadAvg1?: number; memoryPercent?: number } | null = null;
    if (node.last_metrics) {
      try {
        metrics = JSON.parse(node.last_metrics);
      } catch {
        /* ignore */
      }
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

  const best = candidates[0];
  if (!best) {
    // candidates.length was already checked above — this should never happen.
    return null;
  }
  return best.id;
}
