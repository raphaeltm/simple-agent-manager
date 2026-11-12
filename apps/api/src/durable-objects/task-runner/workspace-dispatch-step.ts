/**
 * The `workspace_dispatch` step handler for the TaskRunner DO: send the reserved
 * workspace to its node's VM agent and retry transient failures within the
 * dispatch deadline. Split out of `workspace-steps.ts` (rule 18).
 */
import { log } from '../../lib/logger';
import type { DevcontainerCacheCredentials } from '../../services/devcontainer-cache';
import { SessionRecoveryAuthorityRevokedError } from '../../services/session-recovery-authority';
import { computeBackoffMs, getRecoverySourceTaskGuard, isTransientError } from './helpers';
import type { TaskRunnerContext, TaskRunnerState } from './types';

type TaskRunnerProjectRepo = {
  repoProvider: string | null;
  repository?: string | null;
};

async function loadTaskRunnerProjectRepo(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<TaskRunnerProjectRepo | null> {
  return rc.env.DATABASE.prepare(`SELECT repo_provider AS repoProvider, repository FROM projects WHERE id = ?`)
    .bind(state.projectId)
    .first<TaskRunnerProjectRepo>();
}

async function createWorkspaceOnVmAgent(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  workspaceId: string,
  nodeId: string
): Promise<void> {
  const { signCurrentWorkspaceCallbackToken } = await import('../../services/jwt');
  const { createWorkspaceOnNode } = await import('../../services/node-agent');
  const { resolveWorkspaceGitSource } = await import('../../services/workspace-git-source');
  const callbackToken = await signCurrentWorkspaceCallbackToken(workspaceId, rc.env);
  const projectRepo = await loadTaskRunnerProjectRepo(state, rc);
  const { drizzle } = await import('drizzle-orm/d1');
  const schema = await import('../../db/schema');
  const gitSource = await resolveWorkspaceGitSource(drizzle(rc.env.DATABASE, { schema }), {
    id: state.projectId,
    repoProvider: projectRepo?.repoProvider ?? 'github',
    ...(projectRepo?.repository ? { repository: projectRepo.repository } : {}),
  });
  const checkoutBranch = state.config.outputBranch || state.config.branch;
  const baseBranch =
    checkoutBranch === state.config.branch ? state.config.defaultBranch : state.config.branch;
  const devcontainerCache = await getDevcontainerCacheForWorkspace(state, rc, workspaceId);
  const sourceTaskGuard = getRecoverySourceTaskGuard(state);
  await rc.assertRecoveryAuthority(state);
  const response = await createWorkspaceOnNode(
    nodeId,
    rc.env,
    state.userId,
    {
      workspaceId,
      repository: state.config.repository,
      branch: checkoutBranch,
      baseBranch,
      defaultBranch: state.config.defaultBranch || 'main',
      repoProvider: gitSource.repoProvider,
      cloneUrl: gitSource.cloneUrl,
      repositoryHost: gitSource.repositoryHost,
      repositoryPath: gitSource.repositoryPath,
      callbackToken,
      gitUserName: state.config.userName,
      gitUserEmail: state.config.userEmail,
      githubId: state.config.githubId,
      lightweight: state.config.workspaceProfile === 'lightweight',
      devcontainerConfigName: state.config.devcontainerConfigName ?? undefined,
      devcontainerCache,
      projectId: state.projectId,
      taskId: state.taskId,
    },
    {
      sourceTaskGuard,
      beforeExternalMutation: async () => {
        await rc.assertRecoveryAuthority(state);
      },
    }
  );
  await rc.assertRecoveryAuthority(state);
  if (!isWorkspaceDispatchAck(response, workspaceId)) {
    throw Object.assign(
      new Error(`Node Agent did not acknowledge workspace dispatch for ${workspaceId}`),
      { permanent: true }
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
  rc: TaskRunnerContext
): Promise<void> {
  await rc.updateD1ExecutionStep(state.taskId, 'workspace_dispatch');

  const nodeId = state.stepResults.nodeId;
  const workspaceId = state.stepResults.workspaceId;
  if (!nodeId || !workspaceId) {
    throw new Error('workspace_dispatch requires nodeId and workspaceId');
  }

  const workspace = await rc.env.DATABASE.prepare(
    `SELECT dispatched_at FROM workspaces WHERE id = ?`
  )
    .bind(workspaceId)
    .first<{ dispatched_at: string | null }>();
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
      { permanent: true }
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
    )
      .bind(dispatchedAt, dispatchedAt, workspaceId)
      .run();
    state.workspaceDispatchAckedAt = Date.now();
    state.workspaceDispatchLastError = null;
    await rc.ctx.storage.put('state', state);
    await rc.advanceToStep(state, 'workspace_ready');
  } catch (err) {
    if (err instanceof SessionRecoveryAuthorityRevokedError) throw err;
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
        new Error(
          `Workspace dispatch was not acknowledged by node agent within ${timeoutMs}ms. Last error: ${errorMessage}`
        ),
        { permanent: true }
      );
    }

    const backoffMs = computeBackoffMs(
      state.workspaceDispatchAttempts - 1,
      rc.getWorkspaceDispatchBaseDelayMs(),
      rc.getWorkspaceDispatchMaxDelayMs()
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
  workspaceId: string
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
