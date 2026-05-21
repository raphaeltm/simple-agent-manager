export type NodeReadinessRow = {
  health_status: string | null;
  last_heartbeat_at: string | null;
  agent_ready_at: string | null;
  status: string | null;
} | null;

export function isNodeAgentReadyForWorkspaceDispatch(
  node: NodeReadinessRow,
  waitStartedAtMs: number,
  freshnessSkewMs = 30_000,
): boolean {
  if (!node || node.status !== 'running' || node.health_status !== 'healthy') {
    return false;
  }
  if (!node.last_heartbeat_at || !node.agent_ready_at) {
    return false;
  }

  const heartbeatTime = new Date(node.last_heartbeat_at).getTime();
  const readyTime = new Date(node.agent_ready_at).getTime();
  if (!Number.isFinite(heartbeatTime) || !Number.isFinite(readyTime)) {
    return false;
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

  return heartbeatIsFresh && readyNotAheadOfHeartbeat;
}
