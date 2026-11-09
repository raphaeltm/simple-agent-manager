import { log } from '../../lib/logger';
import {
  claimWorkspaceCreatingExpiry,
  resolveWorkspaceBuildQueueWaitMs,
  workspaceCreatingDeadline,
} from '../../services/workspace-creating-deadline';
import type { TaskRunnerContext, TaskRunnerState } from './types';

interface WorkspaceReadyRow {
  status: string;
  error_message: string | null;
  dispatched_at: string | null;
  created_at: string;
  creating_started_at: string | null;
  build_started_at: string | null;
}

export async function handleWorkspaceReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  if (!state.stepResults.workspaceId) {
    throw new Error('handleWorkspaceReady: workspaceId is null — cannot poll D1');
  }

  // One read serves the dispatch check, the status poll and the deadline. The poll catches a
  // ready callback that updated D1 while the DO notification failed; the deadline is measured
  // from the durable attempt clock, so a missed build-started notification or a DO restart
  // cannot reset or lose it.
  const wsRow = await rc.env.DATABASE.prepare(
    `SELECT status, error_message, dispatched_at, created_at, creating_started_at, build_started_at
       FROM workspaces WHERE id = ?`
  )
    .bind(state.stepResults.workspaceId)
    .first<WorkspaceReadyRow>();

  if (!wsRow) {
    throw Object.assign(new Error(`Workspace ${state.stepResults.workspaceId} no longer exists`), {
      permanent: true,
    });
  }

  if (!wsRow.dispatched_at) {
    log.warn('task_runner_do.workspace_ready_without_dispatch_ack', {
      taskId: state.taskId,
      workspaceId: state.stepResults.workspaceId,
    });
    await rc.advanceToStep(state, 'workspace_dispatch');
    return;
  }

  await rc.updateD1ExecutionStep(state.taskId, 'workspace_ready');

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

  if (wsRow.status === 'running' || wsRow.status === 'recovery') {
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
  if (wsRow.status === 'error') {
    throw Object.assign(new Error(wsRow.error_message || 'Workspace creation failed (D1 poll)'), {
      permanent: true,
    });
  }
  // Any other state (stopped, stopping, deleted, ...) means this start is over without becoming
  // ready. Exit here rather than wait: the expiry claim below only acts on 'creating', so a
  // non-creating row would otherwise lose it on every poll and re-poll forever.
  if (wsRow.status !== 'creating') {
    throw Object.assign(new Error(`Workspace became ${wsRow.status} before it was ready`), {
      permanent: true,
    });
  }

  // Check timeout. The build budget runs from the durable build start; before it, the attempt
  // waits for the node's build slot on the queue budget.
  const budgets = {
    buildMs: rc.getWorkspaceReadyTimeoutMs(),
    queueWaitMs: await resolveWorkspaceBuildQueueWaitMs(rc.env),
  };
  const deadline = workspaceCreatingDeadline(
    {
      createdAt: wsRow.created_at,
      creatingStartedAt: wsRow.creating_started_at,
      buildStartedAt: wsRow.build_started_at,
    },
    budgets
  );
  const now = Date.now();
  if (!Number.isFinite(deadline.deadlineMs) || now > deadline.deadlineMs) {
    const budgetMs =
      deadline.phase === 'building'
        ? budgets.buildMs
        : Math.max(budgets.queueWaitMs, budgets.buildMs);
    const message =
      deadline.phase === 'building'
        ? `Workspace did not become ready within ${budgetMs}ms of its build starting`
        : `Workspace build did not start within ${budgetMs}ms (waiting for the node's build slot)`;
    // The row above was read before this step's other awaits; a ready callback or a build start
    // may have landed since. Fail only if the conditional expiry claim still wins on the current
    // row, the same claim the provisioning-timeout cron makes.
    await rc.assertRecoveryAuthority(state);
    if (
      await claimWorkspaceCreatingExpiry(
        rc.env.DATABASE,
        state.stepResults.workspaceId,
        new Date(now).toISOString(),
        budgets,
        message
      )
    ) {
      throw Object.assign(new Error(message), { permanent: true });
    }
    log.info('task_runner_do.workspace_ready_expiry_lost', {
      taskId: state.taskId,
      workspaceId: state.stepResults.workspaceId,
      phase: deadline.phase,
      action: 'repoll',
    });
    await rc.ctx.storage.setAlarm(Date.now());
    return;
  }

  // No callback yet and not timed out — schedule next poll.
  // The primary advancement mechanism is the VM agent callback
  // (advanceWorkspaceReady RPC). Periodic polling is a safety net for cases
  // where the callback updates D1 but the DO notification fails, or where
  // the VM agent retries the callback via heartbeat after initial failures.
  const pollIntervalMs = rc.getWorkspaceReadyPollIntervalMs();
  const nextPollMs = Math.min(pollIntervalMs, Math.max(deadline.deadlineMs - now, 0));
  await rc.ctx.storage.setAlarm(now + nextPollMs);
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
