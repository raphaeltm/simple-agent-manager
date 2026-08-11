/** Reusable-node heartbeat verification retained for readiness/recovery checks. */
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import type { TaskRunnerContext } from './types';

/**
 * Verify that the VM agent on a node is healthy using D1 heartbeat records.
 * Reusable placement itself is centralized in services/node-selector.ts.
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

    const staleSeconds = Number.parseInt(rc.env.NODE_HEARTBEAT_STALE_SECONDS || '180', 10);
    const heartbeatAge = (Date.now() - new Date(node.last_heartbeat_at).getTime()) / 1000;
    return heartbeatAge < staleSeconds;
  } catch {
    return false;
  }
}
