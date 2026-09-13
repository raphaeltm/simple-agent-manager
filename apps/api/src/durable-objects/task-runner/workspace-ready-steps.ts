import { log } from '../../lib/logger';
import type { TaskRunnerContext, TaskRunnerState } from './types';

export async function handleWorkspaceReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  if (!state.stepResults.workspaceId) {
    throw new Error('handleWorkspaceReady: workspaceId is null — cannot poll D1');
  }

  const dispatchRow = await rc.env.DATABASE.prepare(
    `SELECT dispatched_at FROM workspaces WHERE id = ?`
  )
    .bind(state.stepResults.workspaceId)
    .first<{ dispatched_at: string | null }>();

  if (dispatchRow && !dispatchRow.dispatched_at) {
    log.warn('task_runner_do.workspace_ready_without_dispatch_ack', {
      taskId: state.taskId,
      workspaceId: state.stepResults.workspaceId,
    });
    await rc.advanceToStep(state, 'workspace_dispatch');
    return;
  }

  await rc.updateD1ExecutionStep(state.taskId, 'workspace_ready');

  // Initialize timeout tracking on first entry
  if (!state.workspaceReadyStartedAt) {
    state.workspaceReadyStartedAt = Date.now();
    await rc.ctx.storage.put('state', state);
  }

  // Check if callback already arrived
  if (state.workspaceReadyReceived) {
    if (state.workspaceReadyStatus === 'running' || state.workspaceReadyStatus === 'recovery') {
      log.info('task_runner_do.step.workspace_ready', {
        taskId: state.taskId,
        workspaceId: state.stepResults.workspaceId,
        status: state.workspaceReadyStatus,
      });
      const nextStep = state.config.attachments?.length ? 'attachment_transfer' : 'agent_session';
      await rc.advanceToStep(state, nextStep);
      return;
    }
    if (state.workspaceReadyStatus === 'error') {
      throw Object.assign(new Error(state.workspaceErrorMessage || 'Workspace creation failed'), {
        permanent: true,
      });
    }
  }

  // Poll D1 for workspace status — catches cases where the callback succeeded
  // (updating D1) but the DO notification failed, or where the VM agent retried
  // the callback via heartbeat after initial failures.
  const wsRow = await rc.env.DATABASE.prepare(
    `SELECT status, error_message FROM workspaces WHERE id = ?`
  )
    .bind(state.stepResults.workspaceId)
    .first<{ status: string; error_message: string | null }>();

  if (wsRow?.status === 'running' || wsRow?.status === 'recovery') {
    log.info('task_runner_do.step.workspace_ready_from_d1_poll', {
      taskId: state.taskId,
      workspaceId: state.stepResults.workspaceId,
      status: wsRow.status,
    });
    const nextStepFromPoll = state.config.attachments?.length
      ? 'attachment_transfer'
      : 'agent_session';
    await rc.advanceToStep(state, nextStepFromPoll);
    return;
  }
  if (wsRow?.status === 'error') {
    throw Object.assign(new Error(wsRow.error_message || 'Workspace creation failed (D1 poll)'), {
      permanent: true,
    });
  }

  // Check timeout
  const timeoutMs = rc.getWorkspaceReadyTimeoutMs();
  const elapsed = Date.now() - state.workspaceReadyStartedAt;
  if (elapsed > timeoutMs) {
    throw Object.assign(new Error(`Workspace did not become ready within ${timeoutMs}ms`), {
      permanent: true,
    });
  }

  // No callback yet and not timed out — schedule next poll.
  // The primary advancement mechanism is the VM agent callback
  // (advanceWorkspaceReady RPC). Periodic polling is a safety net for cases
  // where the callback updates D1 but the DO notification fails, or where
  // the VM agent retries the callback via heartbeat after initial failures.
  const pollIntervalMs = rc.getWorkspaceReadyPollIntervalMs();
  const nextPollMs = Math.min(pollIntervalMs, Math.max(timeoutMs - elapsed, 0));
  await rc.ctx.storage.setAlarm(Date.now() + nextPollMs);
}

/**
 * Transfer file attachments from R2 to the workspace's .private/ directory.
 * Downloads each attachment from R2 and uploads it to the VM agent.
 * On success, eagerly deletes R2 keys and advances to agent_session.
 */
export async function handleAttachmentTransfer(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'attachment_transfer');

  const attachments = state.config.attachments;
  if (!attachments || attachments.length === 0) {
    // No attachments — skip directly to agent session
    await rc.advanceToStep(state, 'agent_session');
    return;
  }

  if (!state.stepResults.nodeId || !state.stepResults.workspaceId) {
    throw new Error('Missing nodeId or workspaceId for attachment transfer');
  }

  const { transferWorkspaceAttachments } = await import('../../services/workspace-attachments');
  await transferWorkspaceAttachments({
    env: rc.env,
    userId: state.userId,
    nodeId: state.stepResults.nodeId,
    workspaceId: state.stepResults.workspaceId,
    attachments,
    beforeTransfer: () => rc.assertRecoveryAuthority(state),
  });

  await rc.advanceToStep(state, 'agent_session');
}
