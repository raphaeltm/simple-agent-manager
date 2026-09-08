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

  const { getAttachmentFromR2, cleanupAttachments } =
    await import('../../services/attachment-upload');
  const { signTerminalToken } = await import('../../services/jwt');

  // Build VM agent URL for file upload
  const protocol = rc.env.VM_AGENT_PROTOCOL || 'https';
  const port = rc.env.VM_AGENT_PORT || '8443';
  const workspaceId = state.stepResults.workspaceId;
  const nodeId = state.stepResults.nodeId;
  const baseDomain = rc.env.BASE_DOMAIN || '';
  // Use the two-level node backend hostname for internal Worker → VM-agent calls.
  // The single-level ws-* hostname is the browser workspace proxy and now enforces
  // browser-session-bound terminal tokens.
  const vmUrl = `${protocol}://${nodeId.toLowerCase()}.vm.${baseDomain}:${port}`;
  // Token passed as query param — VM agent's requireWorkspaceRequestAuth() checks
  // r.URL.Query().Get("token"), not Authorization header.
  const uploadBaseUrl = `${vmUrl}/workspaces/${workspaceId}/files/upload`;

  // Generate a terminal token for authenticating with the VM agent
  const { token } = await signTerminalToken(state.userId, workspaceId, rc.env);

  log.info('task_runner_do.step.attachment_transfer_start', {
    taskId: state.taskId,
    workspaceId,
    attachmentCount: attachments.length,
  });

  // Configurable timeout for each attachment transfer
  const DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS = 60_000;
  const transferTimeoutMs =
    parseInt(
      rc.env.ATTACHMENT_TRANSFER_TIMEOUT_MS || String(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS),
      10
    ) || DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS;

  // Transfer each attachment: R2 GET → FormData → VM agent POST
  for (const attachment of attachments) {
    const r2Object = await getAttachmentFromR2(rc.env.R2, state.userId, attachment);

    // Read the R2 body into a Uint8Array for FormData
    const bodyBytes = new Uint8Array(await new Response(r2Object.body).arrayBuffer());

    const formData = new FormData();
    formData.append(
      'files',
      new Blob([bodyBytes], { type: r2Object.contentType }),
      attachment.filename
    );
    // Omit 'destination' field — VM agent defaults to ../.private (sanitizeFilePath rejects explicit ../ paths)

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), transferTimeoutMs);
    let resp: Response;
    try {
      const uploadUrl = `${uploadBaseUrl}?token=${encodeURIComponent(token)}`;
      await rc.assertRecoveryAuthority(state);
      resp = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'unknown');
      throw Object.assign(
        new Error(
          `Attachment transfer failed for ${attachment.filename}: ${resp.status} ${errorText}`
        ),
        { permanent: resp.status >= 400 && resp.status < 500 }
      );
    }

    log.info('task_runner_do.step.attachment_transferred', {
      taskId: state.taskId,
      filename: attachment.filename,
      size: attachment.size,
    });
  }

  // Eager R2 cleanup (best-effort)
  await cleanupAttachments(rc.env.R2, state.userId, attachments);

  log.info('task_runner_do.step.attachment_transfer_complete', {
    taskId: state.taskId,
    attachmentCount: attachments.length,
  });

  await rc.advanceToStep(state, 'agent_session');
}
