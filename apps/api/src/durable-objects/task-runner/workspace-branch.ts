import { log } from '../../lib/logger';
import { SessionRecoveryAuthorityRevokedError } from '../../services/session-recovery-authority';
import {
  ensureWorkspaceBranchOnRemote,
  logWorkspaceBranchResult,
} from '../../services/workspace-branch';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/**
 * Ensure the checkout branch exists on the remote before cloning.
 *
 * Best-effort: failures are logged but do not block workspace creation. That is
 * safe for the VM runtime specifically, because `bootstrap.go:ensureRepositoryReady`
 * clones `baseBranch` and then runs `git checkout -b <branch>`, so a missing ref
 * still produces a working workspace and the clone yields the definitive error.
 * The Instant runtime has no such fallback and therefore fails closed instead —
 * see `services/instant-session.ts`.
 */
export async function ensureBranchExistsOnRemote(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const defaultBranch = state.config.defaultBranch || 'main';
  if (state.config.branch === defaultBranch) return;

  try {
    // Inside the try: this is a best-effort guard, so a transient D1 read
    // failure on `projects` must not fail the task it is trying to help.
    const projectRepo = await loadTaskRunnerProjectRepo(state, rc);

    const result = await ensureWorkspaceBranchOnRemote(rc.env, {
      projectId: state.projectId,
      repository: state.config.repository,
      repoProvider: projectRepo?.repoProvider,
      installationId: state.config.installationId,
      userId: state.userId,
      branch: state.config.branch,
      baseBranch: defaultBranch,
      beforeRemoteWrite: () => rc.assertRecoveryAuthority(state),
    });

    logWorkspaceBranchResult('task_runner_do.ensure_branch', result, {
      taskId: state.taskId,
      branch: state.config.branch,
      defaultBranch,
    });
  } catch (err) {
    // A revoked recovery authority is NOT a best-effort branch failure — it
    // means the source parent terminalized and this replacement must abort
    // rather than continue provisioning.
    if (err instanceof SessionRecoveryAuthorityRevokedError) throw err;
    log.warn('task_runner_do.ensure_branch.error', {
      taskId: state.taskId,
      branch: state.config.branch,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function loadTaskRunnerProjectRepo(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<{ repoProvider: string | null } | null> {
  return rc.env.DATABASE.prepare(`SELECT repo_provider AS repoProvider FROM projects WHERE id = ?`)
    .bind(state.projectId)
    .first<{ repoProvider: string | null }>();
}
