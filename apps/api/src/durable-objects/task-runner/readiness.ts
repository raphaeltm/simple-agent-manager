import { DEFAULT_TASK_RUNNER_AGENT_READY_FRESHNESS_SKEW_MS } from '@simple-agent-manager/shared';

import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';

export type NodeReadinessRow = {
  health_status: string | null;
  last_heartbeat_at: string | null;
  agent_ready_at: string | null;
  status: string | null;
  agent_version?: string | null;
} | null;

export function getNodeAgentReadinessFailure(
  node: NodeReadinessRow,
  waitStartedAtMs: number,
  freshnessSkewMs = DEFAULT_TASK_RUNNER_AGENT_READY_FRESHNESS_SKEW_MS,
  requiredAgentVersion?: string | null
):
  | 'missing_node'
  | 'node_not_running'
  | 'unhealthy_node'
  | 'missing_heartbeat'
  | 'missing_ready_signal'
  | 'agent_version_mismatch'
  | 'invalid_readiness_timestamp'
  | 'stale_heartbeat'
  | 'ready_ahead_of_heartbeat'
  | null {
  if (!node) return 'missing_node';
  if (node.status !== 'running') return 'node_not_running';
  if (
    !isNodeAgentVersionCompatible(node.agent_version, requiredAgentVersion) &&
    (node.last_heartbeat_at || node.agent_ready_at)
  )
    return 'agent_version_mismatch';
  if (node.health_status !== 'healthy') return 'unhealthy_node';
  if (!node.last_heartbeat_at) return 'missing_heartbeat';
  if (!node.agent_ready_at) return 'missing_ready_signal';

  const heartbeatTime = new Date(node.last_heartbeat_at).getTime();
  const readyTime = new Date(node.agent_ready_at).getTime();
  if (!Number.isFinite(heartbeatTime) || !Number.isFinite(readyTime)) {
    return 'invalid_readiness_timestamp';
  }

  const freshnessFloor = waitStartedAtMs - freshnessSkewMs;

  // `/ready` is emitted once during VM agent startup, while heartbeats continue
  // every few seconds after boot. In real provisioning flows, task-runner may
  // enter `node_agent_ready` after `/ready` has already fired (for example, if
  // post-provision bookkeeping or retries delay the poll loop). Gating strictly
  // on a *fresh* `/ready` timestamp causes false negatives where the node is
  // actually healthy and actively heartbeating.
  //
  // Readiness criteria:
  // 1) heartbeat must be fresh relative to this task-runner wait window, and
  // 2) `/ready` must exist and not be implausibly newer than heartbeat.
  //
  // Rule (2) preserves protection against mixed-cycle timestamps while allowing
  // valid startup sequences where `/ready` is older than recent heartbeats.
  const heartbeatIsFresh = heartbeatTime > freshnessFloor;
  const readyNotAheadOfHeartbeat = readyTime <= heartbeatTime + freshnessSkewMs;

  if (!heartbeatIsFresh) return 'stale_heartbeat';
  if (!readyNotAheadOfHeartbeat) return 'ready_ahead_of_heartbeat';
  return null;
}

export function isNodeAgentReadyForWorkspaceDispatch(
  node: NodeReadinessRow,
  waitStartedAtMs: number,
  freshnessSkewMs = DEFAULT_TASK_RUNNER_AGENT_READY_FRESHNESS_SKEW_MS,
  requiredAgentVersion?: string | null
): boolean {
  return (
    getNodeAgentReadinessFailure(node, waitStartedAtMs, freshnessSkewMs, requiredAgentVersion) ===
    null
  );
}
