import * as v from 'valibot';

import { log } from '../lib/logger';
import { readResponseJson } from '../lib/runtime-validation';
import { fetchWithTimeout } from './fetch-timeout';
import {
  type AuthenticatedGitHubUser,
  type AuthenticatedGitHubUserDiagnostics,
  authenticatedGitHubUserSchema,
  GITHUB_REPOSITORY_MAX_PAGE,
  GITHUB_REPOSITORY_PAGE_SIZE,
  GITHUB_REPOSITORY_SCAN_LIMIT,
  githubOrgSchema,
  type GitHubRepositoryAccess,
  githubRepositoryAccessError,
  type GitHubUserOrganization,
  githubUserTokenHeaders,
  installationRepositoriesSchema,
  readGitHubError,
  type UserAccessibleInstallation,
  type UserAccessibleInstallationsDiagnostics,
  type UserInstallationAccessDiagnostics,
  type UserInstallationRepositoriesDiagnostics,
  userInstallationsSchema,
  type UserOrganizationDiagnostics,
} from './github-app-common';

/**
 * Get GitHub App installations accessible to an authenticated GitHub user.
 * This is the user-context check GitHub recommends before trusting a setup
 * callback's installation_id parameter.
 */
export async function getUserAccessibleInstallations(
  accessToken: string,
  diagnostics?: UserAccessibleInstallationsDiagnostics
): Promise<UserAccessibleInstallation[]> {
  const allInstallations: UserAccessibleInstallation[] = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchWithTimeout(
      `https://api.github.com/user/installations?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Simple-Agent-Manager',
        },
      },
      diagnostics?.timeoutMs,
      diagnostics?.callerSignal
    );

    if (!response.ok) {
      log.warn('github.user_accessible_installations.response', {
        flow: diagnostics?.flow,
        userId: diagnostics?.userId,
        installationId: diagnostics?.installationId,
        page,
        status: response.status,
        ok: false,
        installationCount: 0,
      });
      throw new Error(
        await readGitHubError(response, `Failed to get user installations: ${response.status}`)
      );
    }

    const data = await readResponseJson(
      response,
      userInstallationsSchema,
      'github.user_installations'
    );

    log.info('github.user_accessible_installations.response', {
      flow: diagnostics?.flow,
      userId: diagnostics?.userId,
      installationId: diagnostics?.installationId,
      page,
      status: response.status,
      ok: true,
      installationCount: data.installations.length,
    });

    allInstallations.push(
      ...data.installations.map((installation) => ({
        id: installation.id,
        account: installation.account,
      }))
    );

    hasMore = data.installations.length === perPage;
    page++;
  }

  return allInstallations;
}

export function repositoryLookupStartPage(pageHint: number | undefined): number {
  return pageHint &&
    Number.isInteger(pageHint) &&
    pageHint > 0 &&
    pageHint <= GITHUB_REPOSITORY_MAX_PAGE
    ? pageHint
    : 1;
}

export function logUserInstallationRepositoriesResponse(
  response: Response,
  diagnostics: UserInstallationRepositoriesDiagnostics,
  page: number
): void {
  const details = {
    flow: diagnostics.flow,
    userId: diagnostics.userId,
    installationId: diagnostics.installationId,
    repository: diagnostics.repository,
    page,
    status: response.status,
    ok: response.ok,
  };
  if (response.ok) {
    log.info('github.user_installation_repositories.response', details);
  } else {
    log.warn('github.user_installation_repositories.response', details);
  }
}

/**
 * Get repositories accessible to the authenticated GitHub user for a specific
 * app installation. Unlike `/installation/repositories`, this endpoint is
 * filtered by the OAuth user token and is safe for UI lists and authorization.
 */
export async function getUserInstallationRepositories(
  accessToken: string,
  installationId: string,
  diagnostics: UserInstallationRepositoriesDiagnostics,
  lookup?: { repository: string; pageHint?: number; onFound?: (page: number) => Promise<void> }
): Promise<GitHubRepositoryAccess[]> {
  const allRepos: GitHubRepositoryAccess[] = [];
  let page = repositoryLookupStartPage(lookup?.pageHint);
  let checkingHint = page !== 1;
  const perPage = GITHUB_REPOSITORY_PAGE_SIZE;
  let hasMore = true;

  while (hasMore && page <= GITHUB_REPOSITORY_MAX_PAGE) {
    const response = await fetchWithTimeout(
      `https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=${perPage}&page=${page}`,
      {
        headers: githubUserTokenHeaders(accessToken),
      },
      diagnostics?.timeoutMs,
      diagnostics?.callerSignal
    );

    logUserInstallationRepositoriesResponse(response, diagnostics, page);

    if (!response.ok) {
      throw await githubRepositoryAccessError(response);
    }

    const data = await readResponseJson(
      response,
      installationRepositoriesSchema,
      'github.user_installation_repositories'
    );
    allRepos.push(
      ...data.repositories.map((repo) => ({
        id: repo.id,
        nodeId: repo.node_id ?? null,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
      }))
    );

    if (lookup) {
      const match = allRepos.find(
        (repo) => repo.fullName.toLowerCase() === lookup.repository.toLowerCase()
      );
      if (match) {
        await lookup.onFound?.(page);
        return [match];
      }
      // A hint is never authority: repository order/access can change. Re-scan
      // from page one on a miss, checking every response with the current token.
      if (checkingHint) {
        checkingHint = false;
        allRepos.length = 0;
        page = 1;
        continue;
      }
    }
    hasMore = data.repositories.length === perPage;
    page++;

    if (allRepos.length >= GITHUB_REPOSITORY_SCAN_LIMIT) {
      log.warn('github.user_installation_repositories.safety_limit_reached', {
        flow: diagnostics.flow,
        userId: diagnostics.userId,
        installationId: diagnostics.installationId,
        repository: diagnostics.repository,
        repoCount: allRepos.length,
      });
      break;
    }
  }

  return allRepos;
}

/**
 * Fetch the GitHub identity for the OAuth token owner.
 *
 * SAM cannot infer this from `users.github_id` because older production rows may
 * not have that column populated. The OAuth token is the source of truth for the
 * current sync request.
 */
export async function getAuthenticatedGitHubUser(
  accessToken: string,
  diagnostics: AuthenticatedGitHubUserDiagnostics
): Promise<AuthenticatedGitHubUser> {
  const response = await fetchWithTimeout(
    'https://api.github.com/user',
    {
      headers: githubUserTokenHeaders(accessToken),
    },
    diagnostics.timeoutMs,
    diagnostics.callerSignal
  );

  const details = {
    flow: diagnostics.flow,
    userId: diagnostics.userId,
    status: response.status,
    ok: response.ok,
  };
  if (response.ok) {
    log.info('github.authenticated_user.response', details);
  } else {
    log.warn('github.authenticated_user.response', details);
  }

  if (!response.ok) {
    throw new Error(
      await readGitHubError(response, `Failed to get authenticated GitHub user: ${response.status}`)
    );
  }

  return readResponseJson(response, authenticatedGitHubUserSchema, 'github.authenticated_user');
}

/**
 * Fetch organizations for the authenticated GitHub user.
 *
 * This narrows shared installation candidates before SAM considers any
 * organization installation rows already known locally.
 */
export async function getAuthenticatedUserOrganizations(
  accessToken: string,
  diagnostics: UserOrganizationDiagnostics
): Promise<GitHubUserOrganization[]> {
  const allOrganizations: GitHubUserOrganization[] = [];
  let page = 1;
  const perPage = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchWithTimeout(
      `https://api.github.com/user/orgs?per_page=${perPage}&page=${page}`,
      {
        headers: githubUserTokenHeaders(accessToken),
      },
      diagnostics?.timeoutMs,
      diagnostics?.callerSignal
    );

    if (!response.ok) {
      log.warn('github.user_organizations.response', {
        flow: diagnostics.flow,
        userId: diagnostics.userId,
        page,
        status: response.status,
        ok: false,
        organizationCount: 0,
      });
      throw new Error(
        await readGitHubError(response, `Failed to get user organizations: ${response.status}`)
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch (err) {
      throw new Error(
        err instanceof Error
          ? `Failed to parse user organizations response: ${err.message}`
          : 'Failed to parse user organizations response'
      );
    }
    if (!Array.isArray(parsedBody)) {
      throw new Error('Failed to get user organizations: response was not a JSON array');
    }

    log.info('github.user_organizations.response', {
      flow: diagnostics.flow,
      userId: diagnostics.userId,
      page,
      status: response.status,
      ok: true,
      organizationCount: parsedBody.length,
    });

    // Per-entry validation instead of a blind cast: a null/malformed entry
    // previously either crashed (null.login) or silently produced
    // `{ login: undefined }`. Skip and log instead, matching rule 50's
    // list-read fault isolation — one bad entry no longer breaks the page.
    for (const entry of parsedBody) {
      const result = v.safeParse(githubOrgSchema, entry);
      if (result.success) {
        allOrganizations.push({ login: result.output.login });
      } else {
        log.warn('github.user_organizations.invalid_entry', {
          flow: diagnostics.flow,
          userId: diagnostics.userId,
          page,
        });
      }
    }
    hasMore = parsedBody.length === perPage;
    page++;
  }

  return allOrganizations;
}

/**
 * Verify that a GitHub user token can access a specific app installation.
 *
 * 403/404 mean this user cannot use the installation and are represented as
 * false. Other failures are treated as transient and thrown to the caller.
 */
export async function verifyUserInstallationAccess(
  accessToken: string,
  installationId: string,
  diagnostics: UserInstallationAccessDiagnostics
): Promise<boolean> {
  const response = await fetchWithTimeout(
    `https://api.github.com/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=1`,
    {
      headers: githubUserTokenHeaders(accessToken),
    },
    diagnostics.timeoutMs,
    diagnostics.callerSignal
  );

  const details = {
    flow: diagnostics.flow,
    userId: diagnostics.userId,
    installationId: diagnostics.installationId,
    accountName: diagnostics.accountName,
    status: response.status,
    ok: response.ok,
  };
  if (response.ok) {
    log.info('github.user_installation_access.response', details);
  } else {
    log.warn('github.user_installation_access.response', details);
  }

  if (response.ok) {
    return true;
  }

  if (response.status === 403 || response.status === 404) {
    return false;
  }

  throw new Error(
    await readGitHubError(response, `Failed to verify user installation access: ${response.status}`)
  );
}
