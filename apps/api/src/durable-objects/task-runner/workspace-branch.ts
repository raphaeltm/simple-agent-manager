import { log } from '../../lib/logger';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import { SessionRecoveryAuthorityRevokedError } from '../../services/session-recovery-authority';
import type { TaskRunnerContext, TaskRunnerState } from './types';

/**
 * Ensure the checkout branch exists on the remote before cloning.
 *
 * Best-effort: failures are logged but do not block workspace creation. The
 * clone will produce the definitive error if the branch cannot be resolved.
 */
export async function ensureBranchExistsOnRemote(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<void> {
  const defaultBranch = state.config.defaultBranch || 'main';
  if (state.config.branch === defaultBranch) return;

  const projectRepo = await loadTaskRunnerProjectRepo(state, rc);
  if (projectRepo?.repoProvider === 'artifacts') return;
  if (projectRepo?.repoProvider === 'gitlab') {
    await ensureGitLabBranchExistsOnRemote(state, rc, defaultBranch);
    return;
  }

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
    const installation = await loadTaskRunnerGitHubInstallation(state, rc);
    if (!installation) {
      log.warn('task_runner_do.ensure_branch.installation_not_found', {
        taskId: state.taskId,
        installationId: state.config.installationId,
      });
      return;
    }

    const externalInstallationId = getExternalInstallationId(installation);
    const { ensureBranchExists } = await import('../../services/github-app');
    await rc.assertRecoveryAuthority(state);
    const created = await ensureBranchExists(
      externalInstallationId,
      owner,
      repo,
      state.config.branch,
      defaultBranch,
      rc.env
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

async function ensureGitLabBranchExistsOnRemote(
  state: TaskRunnerState,
  rc: TaskRunnerContext,
  defaultBranch: string
): Promise<void> {
  try {
    const { drizzle } = await import('drizzle-orm/d1');
    const schema = await import('../../db/schema');
    const { ensureGitLabBranchExists, getProjectGitLabRepository } =
      await import('../../services/gitlab');
    const metadata = await getProjectGitLabRepository(
      drizzle(rc.env.DATABASE, { schema }),
      state.projectId
    );
    if (!metadata) {
      log.warn('task_runner_do.ensure_branch.gitlab_metadata_missing', {
        taskId: state.taskId,
        projectId: state.projectId,
      });
      return;
    }
    await rc.assertRecoveryAuthority(state);
    const created = await ensureGitLabBranchExists({
      env: rc.env,
      userId: state.userId,
      projectId: metadata.gitlabProjectId,
      branch: state.config.branch,
      ref: defaultBranch,
    });
    if (created) {
      log.info('task_runner_do.ensure_branch.gitlab_ok', {
        taskId: state.taskId,
        branch: state.config.branch,
      });
    }
  } catch (err) {
    if (err instanceof SessionRecoveryAuthorityRevokedError) throw err;
    log.warn('task_runner_do.ensure_branch.gitlab_error', {
      taskId: state.taskId,
      branch: state.config.branch,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type TaskRunnerGitHubInstallation = {
  installationId: string;
  externalInstallationId: string | null;
};

async function loadTaskRunnerGitHubInstallation(
  state: TaskRunnerState,
  rc: TaskRunnerContext
): Promise<TaskRunnerGitHubInstallation | null> {
  return rc.env.DATABASE.prepare(
    `SELECT installation_id AS installationId, external_installation_id AS externalInstallationId
     FROM github_installations
     WHERE id = ? AND user_id = ?`
  )
    .bind(state.config.installationId, state.userId)
    .first<TaskRunnerGitHubInstallation>();
}
