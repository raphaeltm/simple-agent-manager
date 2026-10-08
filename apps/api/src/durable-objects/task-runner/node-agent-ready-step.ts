import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  markVmAdmissionNodeReady,
  renewVmProvisioningLease,
} from '../../services/vm-admission-control';
import { recoverNodeBoot } from './boot-recovery';
import { assertClaimedNodeAvailable } from './claimed-node-availability';
import { getNodeAgentReadinessFailure } from './readiness';
import type { TaskRunnerContext, TaskRunnerState } from './types';

const DEFAULT_FIRST_HEARTBEAT_TIMEOUT_MS = 360_000;

export async function handleNodeAgentReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'node_agent_ready');
  if (state.bootRecovery) {
    await recoverNodeBoot(state, rc, state.bootRecovery.reason);
    return;
  }

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
    `SELECT health_status, last_heartbeat_at, agent_ready_at, agent_version, status, error_message FROM nodes WHERE id = ?`
  )
    .bind(state.stepResults.nodeId)
    .first<{
      health_status: string | null;
      last_heartbeat_at: string | null;
      agent_ready_at: string | null;
      agent_version: string | null;
      status: string;
      error_message: string | null;
    }>();

  if (!(await assertClaimedNodeAvailable(state, rc, node, 'node_agent_ready'))) return;

  // As in provisioning, classify a missing/deleted node before the timeout so
  // failure cleanup cannot attempt to warm a resource that no longer exists.
  const timeoutMs = rc.getAgentReadyTimeoutMs();
  const elapsed = Date.now() - agentReadyStartedAt;
  const firstHeartbeatTimeout = Math.min(
    timeoutMs,
    parsePositiveInt(
      rc.env.TASK_RUNNER_FIRST_HEARTBEAT_TIMEOUT_MS,
      DEFAULT_FIRST_HEARTBEAT_TIMEOUT_MS
    )
  );
  const readinessFailure = getNodeAgentReadinessFailure(
    node,
    agentReadyStartedAt,
    rc.getAgentReadyFreshnessSkewMs(),
    rc.env.VM_AGENT_REQUIRED_VERSION
  );
  let reason: string | null = null;
  if (
    !node?.last_heartbeat_at &&
    !node?.agent_ready_at &&
    node?.error_message?.startsWith('Node boot failed: ')
  ) {
    reason = node.error_message;
  } else if (
    node?.status === 'error' ||
    node?.status === 'stopped' ||
    node?.status === 'destroying'
  ) {
    reason = `node_${node.status}`;
  } else if (readinessFailure === 'agent_version_mismatch') {
    reason = readinessFailure;
  } else if (!node?.last_heartbeat_at && elapsed > firstHeartbeatTimeout) {
    reason = 'first_heartbeat_timeout';
  } else if (elapsed > timeoutMs) {
    reason = `agent_ready_timeout:${readinessFailure}`;
  }
  if (reason) {
    log.warn('task_runner_do.step.node_agent_ready.failed', {
      taskId: state.taskId,
      nodeId: state.stepResults.nodeId,
      reason,
      elapsedMs: elapsed,
      agentVersion: node?.agent_version,
      requiredVersion: rc.env.VM_AGENT_REQUIRED_VERSION,
    });
    await recoverNodeBoot(state, rc, reason);
    return;
  }

  if (readinessFailure === null) {
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

  log.info('task_runner_do.step.node_agent_ready.waiting', {
    taskId: state.taskId,
    nodeId: state.stepResults.nodeId,
    elapsedMs: elapsed,
    reason: readinessFailure,
    lastHeartbeatAt: node?.last_heartbeat_at,
    agentReadyAt: node?.agent_ready_at,
  });

  // Not ready — schedule another poll
  await rc.ctx.storage.setAlarm(Date.now() + rc.getAgentPollIntervalMs());
}
