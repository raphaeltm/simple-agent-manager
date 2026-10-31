import type { Env } from '../env';
import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout } from './fetch-timeout';
import {
  type GitHubRepositoryAccess,
  type InstallationAccount,
  installationDetailSchema,
  installationRepositoriesSchema,
  readGitHubError,
} from './github-app-common';
import { generateAppJWT, getInstallationToken } from './github-app-tokens';

/**
 * Resolve the canonical GitHub account that owns an installation by calling
 * GET /app/installations/{id} with the App JWT.
 *
 * Returns null when the installation no longer exists (404) or has no account
 * object. Used by the residual leak-row sweep to compare the installation's true
 * numeric account id against the owning SAM user's github_id — a comparison that
 * cannot be done in SQL because neither the users table nor the canonical
 * account table stores both the numeric id and the login.
 *
 * Pass `appJwt` to reuse a single App JWT across many calls (e.g. the leak-row
 * sweep resolves up to a full batch of installations per invocation). A GitHub
 * App JWT is valid for 10 minutes, so minting it once avoids one RSA key import
 * + sign per row. When omitted, a fresh JWT is generated.
 */
export async function getInstallationAccount(
  installationId: string,
  env: Env,
  appJwt?: string
): Promise<InstallationAccount | null> {
  const jwt = appJwt ?? (await generateAppJWT(env));

  const response = await fetchWithTimeout(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Simple-Agent-Manager',
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      await readGitHubError(response, `Failed to get installation: ${response.status}`)
    );
  }

  const data = await readResponseJson(
    response,
    installationDetailSchema,
    'github.installation_detail'
  );

  if (!data.account) {
    return null;
  }

  return {
    id: typeof data.account.id === 'number' ? data.account.id : null,
    login: typeof data.account.login === 'string' ? data.account.login : null,
    type: typeof data.account.type === 'string' ? data.account.type : null,
  };
}

/**
 * Get repositories accessible to an installation.
 * Fetches all pages to ensure users with many repositories can find all of them.
 */
export async function getInstallationRepositories(
  installationId: string,
  env: Env
): Promise<GitHubRepositoryAccess[]> {
  const { token } = await getInstallationToken(installationId, env);

  const allRepos: GitHubRepositoryAccess[] = [];
  let page = 1;
  const perPage = 100; // GitHub's max per_page value
  let hasMore = true;

  while (hasMore) {
    const response = await fetchWithTimeout(
      `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        await readGitHubError(response, `Failed to get repositories: ${response.status}`)
      );
    }

    const data = await readResponseJson(
      response,
      installationRepositoriesSchema,
      'github.installation_repositories'
    );

    const repos = data.repositories.map((repo) => ({
      id: repo.id,
      nodeId: repo.node_id ?? null,
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
    }));

    allRepos.push(...repos);

    // Check if there are more pages
    hasMore = data.repositories.length === perPage;
    page++;

    // Safety limit to prevent infinite loops (10,000 repos max)
    if (allRepos.length >= 10000) {
      log.warn('github_app.repo_safety_limit_reached', {
        installationId,
        repoCount: allRepos.length,
      });
      break;
    }
  }

  return allRepos;
}
