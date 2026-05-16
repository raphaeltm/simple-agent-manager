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
  return heartbeatTime > freshnessFloor && readyTime > freshnessFloor;
}
