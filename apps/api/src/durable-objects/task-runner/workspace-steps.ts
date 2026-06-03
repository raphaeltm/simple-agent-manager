/**
 * Workspace-related step handlers for the TaskRunner DO.
 *
 * Handles workspace_creation, workspace_dispatch, workspace_ready, and attachment_transfer steps.
 */
import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import type { DevcontainerCacheCredentials } from '../../services/devcontainer-cache';
import { computeBackoffMs, isTransientError } from './helpers';
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

  await recoverWorkspaceFromD1(state, rc);

  if (state.stepResults.workspaceId) {
    if (await isTaskDelegated(state, rc)) {
      // TDF-6: Ensure session linking on crash recovery — the DO may have crashed
      // after creating the workspace but before linking the session. Dispatch
      // must still be checked separately; D1 workspace linkage is not VM-agent
      // acknowledgement.
      await ensureWorkspaceBookkeeping(state, rc, state.stepResults.workspaceId);
      await rc.advanceToStep(state, 'workspace_dispatch');
      return;
    }
    // If still queued, the DO recovered after workspace row creation but before
    // the task delegation transition. Re-run idempotent bookkeeping before
    // proceeding with delegation and dispatch.
    await ensureWorkspaceBookkeeping(state, rc, state.stepResults.workspaceId);
  } else {
    await createAndProvisionWorkspace(state, rc);
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

  await rc.advanceToStep(state, 'workspace_dispatch');
}

async function recoverWorkspaceFromD1(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  // If workspace already created (retry or crash recovery), skip creation.
  // Check both DO state AND D1 to handle the crash window between D1 insert
  // and storage.put — if D1 has a workspace_id for this task but the DO
  // state doesn't, recover it.
  if (state.stepResults.workspaceId) {
    return;
  }

  const existingTask = await rc.env.DATABASE.prepare(
    `SELECT workspace_id, status FROM tasks WHERE id = ?`
  ).bind(state.taskId).first<{ workspace_id: string | null; status: string }>();

  if (!existingTask?.workspace_id) {
    return;
  }

  // D1 has a workspace — recover it into DO state (crash recovery)
  state.stepResults.workspaceId = existingTask.workspace_id;
  await rc.ctx.storage.put('state', state);

  log.info('task_runner_do.workspace_recovered_from_d1', {
    taskId: state.taskId,
    workspaceId: existingTask.workspace_id,
  });
}

async function isTaskDelegated(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<boolean> {
  const task = await rc.env.DATABASE.prepare(
    `SELECT status FROM tasks WHERE id = ?`
  ).bind(state.taskId).first<{ status: string }>();

  return task?.status === 'delegated';
}

async function createAndProvisionWorkspace(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  const { ulid } = await import('../../lib/ulid');
  const { resolveUniqueWorkspaceDisplayName } = await import('../../services/workspace-names');
  const { drizzle } = await import('drizzle-orm/d1');
  const schema = await import('../../db/schema');

  const db = drizzle(rc.env.DATABASE, { schema });
  const nodeId = state.stepResults.nodeId;
  if (!nodeId) {
    throw new Error('No nodeId in state — cannot create workspace');
  }
  const workspaceId = ulid();
  const workspaceName = `Task: ${state.config.taskTitle.slice(0, 50)}`;
  const uniqueName = await resolveUniqueWorkspaceDisplayName(
    db,
    nodeId,
    workspaceName
  );
  const now = new Date().toISOString();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    nodeId,
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
    devcontainerConfigName: state.config.devcontainerConfigName ?? null,
    agentProfileHint: state.config.agentProfileHint ?? null,
    createdAt: now,
    updatedAt: now,
  });

  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET workspace_id = ?, updated_at = ? WHERE id = ?`
  ).bind(workspaceId, now, state.taskId).run();

  state.stepResults.workspaceId = workspaceId;
  await rc.ctx.storage.put('state', state);
  await startComputeTrackingBestEffort(state, rc, db, workspaceId, nodeId);
  await ensureWorkspaceBookkeeping(state, rc, workspaceId, now);
  await rc.ctx.storage.put('state', state);
}

async function ensureWorkspaceBookkeeping(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  now = new Date().toISOString(),
): Promise<void> {
  await ensureSessionLinked(state, workspaceId, rc);
  await setOutputBranch(state, rc, now);
  await ensureBranchExistsOnRemote(state, rc);
}

async function startComputeTrackingBestEffort(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  db: unknown,
  workspaceId: string,
  nodeId: string,
): Promise<void> {
  try {
    const { startComputeTracking } = await import('../../services/compute-usage');
    const nodeRow = await rc.env.DATABASE.prepare(
      `SELECT cloud_provider, credential_source FROM nodes WHERE id = ?`
    ).bind(nodeId).first<{
      cloud_provider: string | null;
      credential_source: string | null;
    }>();

    await startComputeTracking(db as Parameters<typeof startComputeTracking>[0], {
      userId: state.userId,
      workspaceId,
      nodeId,
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
}

async function setOutputBranch(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  now: string,
): Promise<void> {
  const outputBranch = state.config.outputBranch || `task/${state.taskId}`;
  await rc.env.DATABASE.prepare(
    `UPDATE tasks SET output_branch = ?, updated_at = ? WHERE id = ?`
  ).bind(outputBranch, now, state.taskId).run();
}

/**
 * Ensure the checkout branch exists on the remote before cloning.
 * If the branch differs from the project's default branch and doesn't exist,
 * create it from the default branch via the GitHub API.
 *
 * Best-effort: failures are logged but do not block workspace creation.
 * The clone will fail with a clear error from the VM agent if the branch
 * truly doesn't exist.
 */
export async function ensureBranchExistsOnRemote(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  const defaultBranch = state.config.defaultBranch || 'main';

  // If cloning the default branch, no need to check — it always exists
  if (state.config.branch === defaultBranch) {
    return;
  }

  // Parse owner/repo from repository string (format: "owner/repo")
  const repoParts = state.config.repository.split('/');
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    log.warn('task_runner_do.ensure_branch.invalid_repository', {
      taskId: state.taskId,
      repository: state.config.repository,
    });
    return;
  }

  const [owner, repo] = repoParts;

  try {
    const { ensureBranchExists } = await import('../../services/github-app');
    const created = await ensureBranchExists(
      state.config.installationId,
      owner,
      repo,
      state.config.branch,
      defaultBranch,
      rc.env,
    );

    if (created) {
      log.info('task_runner_do.ensure_branch.ok', {
        taskId: state.taskId,
        branch: state.config.branch,
      });
    } else {
      log.warn('task_runner_do.ensure_branch.failed', {
        taskId: state.taskId,
        branch: state.config.branch,
        defaultBranch,
      });
    }
  } catch (err) {
    log.warn('task_runner_do.ensure_branch.error', {
      taskId: state.taskId,
      branch: state.config.branch,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function createWorkspaceOnVmAgent(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  nodeId: string,
): Promise<void> {
  const { signCallbackToken } = await import('../../services/jwt');
  const { createWorkspaceOnNode } = await import('../../services/node-agent');
  const callbackToken = await signCallbackToken(workspaceId, rc.env);

  const response = await createWorkspaceOnNode(nodeId, rc.env, state.userId, {
    workspaceId,
    repository: state.config.repository,
    branch: state.config.branch,
    callbackToken,
    gitUserName: state.config.userName,
    gitUserEmail: state.config.userEmail,
    githubId: state.config.githubId,
    lightweight: state.config.workspaceProfile === 'lightweight',
    devcontainerConfigName: state.config.devcontainerConfigName ?? undefined,
    devcontainerCache: await getDevcontainerCacheForWorkspace(state, rc, workspaceId),
  });

  if (!isWorkspaceDispatchAck(response, workspaceId)) {
    throw Object.assign(
      new Error(`Node Agent did not acknowledge workspace dispatch for ${workspaceId}`),
      { permanent: true },
    );
  }
}

function isWorkspaceDispatchAck(response: unknown, workspaceId: string): boolean {
  if (!response || typeof response !== 'object') {
    return false;
  }
  const record = response as Record<string, unknown>;
  return record.workspaceId === workspaceId;
}

export async function handleWorkspaceDispatch(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'workspace_dispatch');

  const nodeId = state.stepResults.nodeId;
  const workspaceId = state.stepResults.workspaceId;
  if (!nodeId || !workspaceId) {
    throw new Error('workspace_dispatch requires nodeId and workspaceId');
  }

  const workspace = await rc.env.DATABASE.prepare(
    `SELECT dispatched_at FROM workspaces WHERE id = ?`
  ).bind(workspaceId).first<{ dispatched_at: string | null }>();
  if (!workspace) {
    throw Object.assign(new Error(`Workspace ${workspaceId} not found for dispatch`), {
      permanent: true,
    });
  }

  if (workspace.dispatched_at) {
    state.workspaceDispatchAckedAt ??= Date.now();
    await rc.ctx.storage.put('state', state);
    await rc.advanceToStep(state, 'workspace_ready');
    return;
  }

  const now = Date.now();
  if (!state.workspaceDispatchStartedAt) {
    state.workspaceDispatchStartedAt = now;
  }

  const timeoutMs = rc.getWorkspaceDispatchTimeoutMs();
  const elapsedMs = now - state.workspaceDispatchStartedAt;
  if (elapsedMs > timeoutMs) {
    throw Object.assign(
      new Error(`Workspace dispatch was not acknowledged by node agent within ${timeoutMs}ms`),
      { permanent: true },
    );
  }

  state.workspaceDispatchAttempts += 1;
  state.workspaceDispatchLastAttemptAt = now;
  await rc.ctx.storage.put('state', state);

  try {
    await createWorkspaceOnVmAgent(state, rc, workspaceId, nodeId);
    const dispatchedAt = new Date().toISOString();
    await rc.env.DATABASE.prepare(
      `UPDATE workspaces SET dispatched_at = ?, updated_at = ? WHERE id = ?`
    ).bind(dispatchedAt, dispatchedAt, workspaceId).run();
    state.workspaceDispatchAckedAt = Date.now();
    state.workspaceDispatchLastError = null;
    await rc.ctx.storage.put('state', state);
    await rc.advanceToStep(state, 'workspace_ready');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    state.workspaceDispatchLastError = errorMessage;
    await rc.ctx.storage.put('state', state);

    if (!isTransientError(err)) {
      throw Object.assign(new Error(errorMessage), { permanent: true });
    }

    const dispatchStartedAt = state.workspaceDispatchStartedAt ?? Date.now();
    const elapsedAfterAttemptMs = Date.now() - dispatchStartedAt;
    const remainingMs = timeoutMs - elapsedAfterAttemptMs;
    if (remainingMs <= 0) {
      throw Object.assign(
        new Error(`Workspace dispatch was not acknowledged by node agent within ${timeoutMs}ms. Last error: ${errorMessage}`),
        { permanent: true },
      );
    }

    const backoffMs = computeBackoffMs(
      state.workspaceDispatchAttempts - 1,
      rc.getWorkspaceDispatchBaseDelayMs(),
      rc.getWorkspaceDispatchMaxDelayMs(),
    );
    const nextDelayMs = Math.min(backoffMs, remainingMs);
    await rc.ctx.storage.setAlarm(Date.now() + nextDelayMs);

    log.warn('task_runner_do.workspace_dispatch_retry_scheduled', {
      taskId: state.taskId,
      workspaceId,
      nodeId,
      attempts: state.workspaceDispatchAttempts,
      backoffMs: nextDelayMs,
      error: errorMessage,
    });
  }
}

async function getDevcontainerCacheForWorkspace(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
): Promise<DevcontainerCacheCredentials | null> {
  if (state.config.workspaceProfile === 'lightweight') {
    return null;
  }

  try {
    const { getDevcontainerCacheCredentials } = await import('../../services/devcontainer-cache');
    return await getDevcontainerCacheCredentials(
      rc.env,
      state.config.repository,
      state.config.devcontainerConfigName
    );
  } catch (err) {
    log.warn('task_runner_do.devcontainer_cache_credentials_failed', {
      taskId: state.taskId,
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function handleWorkspaceReady(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
): Promise<void> {
  if (!state.stepResults.workspaceId) {
    throw new Error('handleWorkspaceReady: workspaceId is null — cannot poll D1');
  }

  const dispatchRow = await rc.env.DATABASE.prepare(
    `SELECT dispatched_at FROM workspaces WHERE id = ?`
  ).bind(state.stepResults.workspaceId).first<{ dispatched_at: string | null }>();

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
      throw Object.assign(
        new Error(state.workspaceErrorMessage || 'Workspace creation failed'),
        { permanent: true },
      );
    }
  }

  // Poll D1 for workspace status — catches cases where the callback succeeded
  // (updating D1) but the DO notification failed, or where the VM agent retried
  // the callback via heartbeat after initial failures.
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
