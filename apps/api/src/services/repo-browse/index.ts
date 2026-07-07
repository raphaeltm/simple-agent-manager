import type * as schema from '../../db/schema';
import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { GitHubRepoBrowser } from './github';
import type { RepoBrowser } from './types';

export type { RepoBrowser } from './types';

/**
 * Resolve the read-only {@link RepoBrowser} for a project based on its
 * `repoProvider`. GitHub is resolved eagerly; Artifacts is lazily imported so
 * the isomorphic-git bundle is only loaded for Artifacts-backed projects.
 *
 * The caller MUST have already enforced project access AND, for GitHub, the
 * user∩app repo-access gate (`requireRepositoryUserAccess`) before calling.
 */
export async function resolveRepoBrowser(opts: {
  project: schema.Project;
  env: Env;
  /** External GitHub installation id (required for GitHub-backed projects). */
  externalInstallationId?: string;
}): Promise<RepoBrowser> {
  const { project, env, externalInstallationId } = opts;
  const provider = project.repoProvider ?? 'github';

  if (provider === 'github') {
    const [owner, repo] = project.repository.split('/');
    if (!owner || !repo) {
      throw errors.badRequest('Project repository is malformed');
    }
    if (!externalInstallationId) {
      throw errors.badRequest('Project has no GitHub installation');
    }
    return new GitHubRepoBrowser(owner, repo, project.defaultBranch, externalInstallationId, env);
  }

  if (provider === 'artifacts') {
    if (env.ARTIFACTS_ENABLED !== 'true' || !env.ARTIFACTS) {
      throw errors.badRequest('Artifacts is not enabled on this deployment');
    }
    if (!project.artifactsRepoId) {
      throw errors.badRequest('Project has no Artifacts repository');
    }
    const { createArtifactsRepoBrowser } = await import('./artifacts');
    return createArtifactsRepoBrowser({
      repoId: project.artifactsRepoId,
      defaultBranch: project.defaultBranch,
      env,
    });
  }

  throw errors.badRequest(`Unsupported repository provider: ${provider}`);
}
