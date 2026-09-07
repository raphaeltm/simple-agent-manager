import { log } from '../../lib/logger';
import { markVmAdmissionNodeReady, renewVmProvisioningLease } from '../../services/vm-admission-control';
import { assertClaimedNodeAvailable } from './claimed-node-availability';
import { isNodeAgentReadyForWorkspaceDispatch } from './readiness';
import type { TaskRunnerContext, TaskRunnerState } from './types';

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
  await renewVmProvisioningLease(
    rc.env,
    state.admissionScopeKey,
    state.taskId,
    state.admissionLeaseToken
  );

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
      rc.getAgentReadyFreshnessSkewMs(),
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
    await markVmAdmissionNodeReady(rc.env, {
      taskId: state.taskId,
      nodeId: state.stepResults.nodeId,
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
