/**
 * Workspace-related step handlers for the TaskRunner DO.
 *
 * Handles workspace_creation, workspace_ready, and attachment_transfer steps.
 */
import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { ensureSessionLinked } from './state-machine';
import type { TaskRunnerContext, TaskRunnerState } from './types';

// =========================================================================
// Step Handlers
// =========================================================================

export async function handleWorkspaceCreation(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'workspace_creation');

  if (!state.stepResults.nodeId) {
    throw new Error('No nodeId in state — cannot create workspace');
  }

  // If workspace already created (retry or crash recovery), skip creation.
  // Check both DO state AND D1 to handle the crash window between D1 insert
  // and storage.put — if D1 has a workspace_id for this task but the DO
  // state doesn't, recover it.
  if (!state.stepResults.workspaceId) {
    const existingTask = await rc.env.DATABASE.prepare(
      `SELECT workspace_id, status FROM tasks WHERE id = ?`
    ).bind(state.taskId).first<{ workspace_id: string | null; status: string }>();

    if (existingTask?.workspace_id) {
      // D1 has a workspace — recover it into DO state (crash recovery)
      state.stepResults.workspaceId = existingTask.workspace_id;
      await rc.ctx.storage.put('state', state);

      log.info('task_runner_do.workspace_recovered_from_d1', {
        taskId: state.taskId,
        workspaceId: existingTask.workspace_id,
      });
    }
  }

  if (state.stepResults.workspaceId) {
    // Check if we already transitioned to delegated
    const task = await rc.env.DATABASE.prepare(
      `SELECT status FROM tasks WHERE id = ?`
    ).bind(state.taskId).first<{ status: string }>();

    if (task?.status === 'delegated') {
      // TDF-6: Ensure session linking on crash recovery — the DO may have crashed
      // after creating the workspace but before linking the session.
      await ensureSessionLinked(state, state.stepResults.workspaceId, rc);
      await rc.advanceToStep(state, 'workspace_ready');
      return;
    }
    // If still queued, proceed with delegation transition below
  } else {
    // Create workspace in D1
    const { ulid } = await import('../../lib/ulid');
    const { resolveUniqueWorkspaceDisplayName } = await import('../../services/workspace-names');
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../../db/schema');

    const db = drizzle(rc.env.DATABASE, { schema });
    const workspaceId = ulid();
    const workspaceName = `Task: ${state.config.taskTitle.slice(0, 50)}`;
    const uniqueName = await resolveUniqueWorkspaceDisplayName(db, state.stepResults.nodeId, workspaceName);
    const now = new Date().toISOString();

    await db.insert(schema.workspaces).values({
      id: workspaceId,
      nodeId: state.stepResults.nodeId,
      projectId: state.projectId,
      userId: state.userId,
      installationId: state.config.installationId,
      name: workspaceName,
      displayName: uniqueName.displayName,
      normalizedDisplayName: uniqueName.normalizedDisplayName,
      repository: state.config.repository,
      branch: state.config.branch,
      status: 'creating',
      vmSize: state.config.vmSize,
      vmLocation: state.config.vmLocation,
      workspaceProfile: state.config.workspaceProfile ?? DEFAULT_WORKSPACE_PROFILE,
      createdAt: now,
      updatedAt: now,
    });

    // Update task with workspace ID
    await rc.env.DATABASE.prepare(
      `UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ?`
    ).bind(workspaceId, now, state.taskId).run();

    state.stepResults.workspaceId = workspaceId;
    await rc.ctx.storage.put('state', state);

    // Start compute usage metering (best-effort)
    try {
      const { startComputeTracking } = await import('../../services/compute-usage');
      const nodeRow = await rc.env.DATABASE.prepare(
        `SELECT cloud_provider, credential_source FROM nodes WHERE id = ?`
      ).bind(state.stepResults.nodeId).first<{ cloud_provider: string | null; credential_source: string | null }>();

      await startComputeTracking(db, {
        userId: state.userId,
        workspaceId,
        nodeId: state.stepResults.nodeId,
        vmSize: state.config.vmSize,
        cloudProvider: nodeRow?.cloud_provider,
        credentialSource: (nodeRow?.credential_source as 'user' | 'platform') ?? 'user',
      });
    } catch (err) {
      log.error('task_runner_do.compute_tracking_start_failed', {
        taskId: state.taskId,
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // TDF-6: Link existing chat session to workspace (session created at submit time).
    // No new session creation here — one session per task. Uses shared helper
    // so crash recovery path also gets session linking (MEDIUM #1 fix).
    await ensureSessionLinked(state, workspaceId, rc);

    // Set output_branch
    const outputBranch = state.config.outputBranch || `task/${state.taskId}`;
    await rc.env.DATABASE.prepare(
      `UPDATE tasks SET output_branch = ?, updated_at = ? WHERE id = ?`
    ).bind(outputBranch, now, state.taskId).run();

    // Create workspace on VM agent
    const { signCallbackToken } = await import('../../services/jwt');
    const { createWorkspaceOnNode } = await import('../../services/node-agent');

    const callbackToken = await signCallbackToken(workspaceId, rc.env);
    await createWorkspaceOnNode(state.stepResults.nodeId, rc.env, state.userId, {
      workspaceId,
      repository: state.config.repository,
      branch: state.config.branch,
      callbackToken,
      gitUserName: state.config.userName,
      gitUserEmail: state.config.userEmail,
      githubId: state.config.githubId,
      lightweight: state.config.workspaceProfile === 'lightweight',
    });

    await rc.ctx.storage.put('state', state);
  }

  // Transition task: queued → delegated (optimistic locking)
  const now = new Date().toISOString();
  const result = await rc.env.DATABASE.prepare(
    `UPDATE tasks SET status = 'delegated', updated_at = ? WHERE id = ? AND status = 'queued'`
  ).bind(now, state.taskId).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    // Task was already failed by cron recovery — abort gracefully
    log.warn('task_runner_do.aborted_by_recovery', {
      taskId: state.taskId,
      step: 'delegated_transition',
    });
    state.completed = true;
    await rc.ctx.storage.put('state', state);
    return;
  }

  // Record status event
  const { ulid } = await import('../../lib/ulid');
  await rc.env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status, actor_type, actor_id, reason, created_at)
     VALUES (?, ?, 'queued', 'delegated', 'system', NULL, ?, ?)`
  ).bind(
    ulid(),
    state.taskId,
    `Delegated to workspace ${state.stepResults.workspaceId} on node ${state.stepResults.nodeId}`,
    now,
  ).run();

  await rc.advanceToStep(state, 'workspace_ready');
}

export async function handleWorkspaceReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
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
      throw Object.assign(
        new Error(state.workspaceErrorMessage || 'Workspace creation failed'),
        { permanent: true },
      );
    }
  }

  // Poll D1 for workspace status — catches cases where the callback succeeded
  // (updating D1) but the DO notification failed, or where the VM agent retried
  // the callback via heartbeat after initial failures.
  if (!state.stepResults.workspaceId) {
    throw new Error('handleWorkspaceReady: workspaceId is null — cannot poll D1');
  }
  const wsRow = await rc.env.DATABASE.prepare(
    `SELECT status, error_message FROM workspaces WHERE id = ?`
  ).bind(state.stepResults.workspaceId).first<{ status: string; error_message: string | null }>();

  if (wsRow?.status === 'running' || wsRow?.status === 'recovery') {
    log.info('task_runner_do.step.workspace_ready_from_d1_poll', {
      taskId: state.taskId,
      workspaceId: state.stepResults.workspaceId,
      status: wsRow.status,
    });
    const nextStepFromPoll = state.config.attachments?.length ? 'attachment_transfer' : 'agent_session';
    await rc.advanceToStep(state, nextStepFromPoll);
    return;
  }
  if (wsRow?.status === 'error') {
    throw Object.assign(
      new Error(wsRow.error_message || 'Workspace creation failed (D1 poll)'),
      { permanent: true },
    );
  }

  // Check timeout
  const timeoutMs = rc.getWorkspaceReadyTimeoutMs();
  const elapsed = Date.now() - state.workspaceReadyStartedAt;
  if (elapsed > timeoutMs) {
    throw Object.assign(
      new Error(`Workspace did not become ready within ${timeoutMs}ms`),
      { permanent: true },
    );
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
  rc: TaskRunnerContext,
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

  const { getAttachmentFromR2, cleanupAttachments } = await import('../../services/attachment-upload');
  const { signTerminalToken } = await import('../../services/jwt');

  // Build VM agent URL for file upload
  const protocol = rc.env.VM_AGENT_PROTOCOL || 'https';
  const port = rc.env.VM_AGENT_PORT || '8443';
  const workspaceId = state.stepResults.workspaceId;
  const baseDomain = rc.env.BASE_DOMAIN || '';
  const vmUrl = `${protocol}://ws-${workspaceId}.${baseDomain}:${port}`;
  // Token passed as query param — VM agent's requireWorkspaceRequestAuth() checks
  // r.URL.Query().Get("token"), not Authorization header.
  const uploadBaseUrl = `${vmUrl}/workspaces/${workspaceId}/files/upload`;

  // Generate a terminal token for authenticating with the VM agent
  const { token } = await signTerminalToken(
    state.userId,
    workspaceId,
    rc.env,
  );

  log.info('task_runner_do.step.attachment_transfer_start', {
    taskId: state.taskId,
    workspaceId,
    attachmentCount: attachments.length,
  });

  // Configurable timeout for each attachment transfer
  const DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS = 60_000;
  const transferTimeoutMs = parseInt(
    rc.env.ATTACHMENT_TRANSFER_TIMEOUT_MS || String(DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS),
    10,
  ) || DEFAULT_ATTACHMENT_TRANSFER_TIMEOUT_MS;

  // Transfer each attachment: R2 GET → FormData → VM agent POST
  for (const attachment of attachments) {
    const r2Object = await getAttachmentFromR2(rc.env.R2, state.userId, attachment);

    // Read the R2 body into a Uint8Array for FormData
    const bodyBytes = new Uint8Array(await new Response(r2Object.body).arrayBuffer());

    const formData = new FormData();
    formData.append('files', new Blob([bodyBytes], { type: r2Object.contentType }), attachment.filename);
    // Omit 'destination' field — VM agent defaults to ../.private (sanitizeFilePath rejects explicit ../ paths)

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), transferTimeoutMs);
    let resp: Response;
    try {
      const uploadUrl = `${uploadBaseUrl}?token=${encodeURIComponent(token)}`;
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
        new Error(`Attachment transfer failed for ${attachment.filename}: ${resp.status} ${errorText}`),
        { permanent: resp.status >= 400 && resp.status < 500 },
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
