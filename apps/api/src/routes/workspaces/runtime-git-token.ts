import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { getInstallationToken, getUserInstallationRepositories } from '../../services/github-app';
import {
  GitHubCliPolicyError,
  resolveWorkspaceGitHubTokenOptions,
} from '../../services/github-cli-policy';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import { backfillProjectGithubRepoId } from '../../services/github-repo-id-backfill';
import { getGitHubUserAccessTokenForOwner } from '../../services/github-user-access-token';
import {
  getProjectGitLabRepository,
  requireGitLabUserAccessTokenResultForOwner,
  verifyGitLabProjectAccess,
} from '../../services/gitlab';
import { resolveArtifactsBackend } from '../../services/hosted-git/backend';
import { boundArtifactsRepositoryHost } from '../../services/workspace-git-source';
import { assertRepositoryAccess } from '../projects/_helpers';
import {
  assertWorkspaceAcceptsCallback,
  assertWorkspaceCallbackIdentityCurrent,
  verifyWorkspaceCallbackAuth,
  workspaceCallbackIdentityFields,
} from './_helpers';
import { callbackJsonWithJit } from './runtime-callback-response';
const runtimeRoutes = new Hono<{ Bindings: Env }>();
async function verifyWorkspaceGitHubOwnerAccess(input: {
  env: Env;
  workspaceId: string;
  projectId: string | null;
  userId: string;
  repository: string;
  externalInstallationId: string;
  githubRepoId: number | null;
}): Promise<number> {
  const accessToken = await getGitHubUserAccessTokenForOwner(
    input.env,
    input.userId,
    'workspace-git-token'
  );
  if (!accessToken) {
    log.warn('workspace_git_token_user_access_missing', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      action: 'rejected',
    });
    throw errors.forbidden('GitHub user token unavailable');
  }

  // Every git and gh credential exchange lands here, so pass env to use the
  // pagination hint (GITHUB_REPO_ACCESS_CACHE_TTL_SECONDS). Every exchange
  // still verifies current user access against GitHub; hints never grant access.
  const verifiedRepo = await assertRepositoryAccess(
    accessToken,
    input.externalInstallationId,
    input.repository,
    input.userId,
    'project-access',
    input.env
  );

  if (input.githubRepoId !== null && verifiedRepo.id !== input.githubRepoId) {
    log.warn('workspace_git_token_repo_id_drift', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      expectedRepoId: input.githubRepoId,
      verifiedRepoId: verifiedRepo.id,
      action: 'rejected',
    });
    throw errors.forbidden('GitHub repository access has changed; repository ID no longer matches');
  }

  return verifiedRepo.id;
}

/**
 * Resolve numeric repository IDs for a project's additional Repository Access
 * entries, re-verifying user∩app access at the token-mint boundary. Stored rows
 * whose access has been revoked (or whose installation no longer exposes them)
 * are dropped from the scope — an unselected/inaccessible repo simply never makes
 * it into the minted token's `repository_ids`, so it fails clearly downstream.
 * Failure to fetch the accessible set returns the empty set rather than throwing,
 * so the primary-repo token still mints (additional repos degrade, never break
 * the primary clone).
 */
async function resolveAdditionalRepositoryIds(input: {
  env: Env;
  db: ReturnType<typeof drizzle<typeof schema>>;
  workspaceId: string;
  projectId: string;
  userId: string;
  externalInstallationId: string;
}): Promise<number[]> {
  const rows = await input.db
    .select({
      repository: schema.projectGithubRepositories.repository,
      githubRepoId: schema.projectGithubRepositories.githubRepoId,
    })
    .from(schema.projectGithubRepositories)
    .where(eq(schema.projectGithubRepositories.projectId, input.projectId));
  if (rows.length === 0) {
    return [];
  }

  const accessToken = await getGitHubUserAccessTokenForOwner(
    input.env,
    input.userId,
    'workspace-git-token'
  );
  if (!accessToken) {
    log.warn('workspace_git_token_additional_repos_user_access_missing', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      action: 'additional_repos_skipped',
    });
    return [];
  }

  let accessibleById: Map<string, number>;
  try {
    const repositories = await getUserInstallationRepositories(
      accessToken,
      input.externalInstallationId,
      {
        flow: 'project-access',
        userId: input.userId,
        installationId: input.externalInstallationId,
      }
    );
    accessibleById = new Map(repositories.map((r) => [r.fullName.toLowerCase(), r.id]));
  } catch (err) {
    log.warn('workspace_git_token_additional_repos_unavailable', {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
      error: err instanceof Error ? err.message : String(err),
      action: 'additional_repos_skipped',
    });
    return [];
  }

  const ids: number[] = [];
  for (const row of rows) {
    const accessibleId = accessibleById.get(row.repository.toLowerCase());
    if (accessibleId === undefined) {
      log.warn('workspace_git_token_additional_repo_access_revoked', {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        userId: input.userId,
        repository: row.repository,
        action: 'excluded_from_scope',
      });
      continue;
    }
    // Prefer the live, rename-stable id from the accessible set. Stored ids can
    // drift if the repo was deleted/recreated; the live id is authoritative.
    ids.push(accessibleId);
  }
  return ids;
}

runtimeRoutes.post('/:id/git-token', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  const db = drizzle(c.env.DATABASE, { schema });

  // Look up workspace → project to determine repo provider
  const workspaceRows = await db
    .select({
      ...workspaceCallbackIdentityFields,
      installationId: schema.workspaces.installationId,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const workspace = await assertWorkspaceAcceptsCallback(
    c.env,
    workspaceRows[0],
    workspaceId,
    'git_token'
  );

  // Look up the project to check repoProvider
  let repoProvider = 'github';
  let artifactsRepoId: string | null = null;
  let githubRepoId: number | null = null;
  let repositoryName: string | null = null;
  if (workspace.projectId) {
    const projectRows = await db
      .select({
        repoProvider: schema.projects.repoProvider,
        artifactsRepoId: schema.projects.artifactsRepoId,
        githubRepoId: schema.projects.githubRepoId,
        repository: schema.projects.repository,
      })
      .from(schema.projects)
      .where(eq(schema.projects.id, workspace.projectId))
      .limit(1);

    const project = projectRows[0];
    if (project) {
      repoProvider = project.repoProvider || 'github';
      artifactsRepoId = project.artifactsRepoId;
      githubRepoId = project.githubRepoId;
      repositoryName = project.repository;
    }
  }

  if (repoProvider === 'artifacts') {
    // ─── Artifacts token ──────────────────────────────────────────────
    if (c.env.ARTIFACTS_ENABLED !== 'true') {
      throw errors.forbidden('Artifacts provider is not enabled');
    }
    const artifacts = resolveArtifactsBackend(c.env);
    if (!artifacts || !artifactsRepoId) {
      throw errors.internal('Artifacts binding or repo ID missing');
    }

    // Clamp the token TTL to a sane range: a negative/zero/NaN or excessively
    // large configured value must not mint a token that never expires (or expires
    // instantly). Default 1h; hard cap 24h.
    const rawTtl = Number.parseInt(c.env.ARTIFACTS_TOKEN_TTL_SECONDS || '', 10);
    const ttl = Number.isFinite(rawTtl) && rawTtl > 0 && rawTtl <= 86400 ? rawTtl : 3600;
    // Use requested scope or default to 'write' (agents need push access)
    const requestedScope = c.req.query('scope') === 'read' ? ('read' as const) : ('write' as const);
    const repo = await artifacts.get(artifactsRepoId);
    await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'git_token');
    const tokenResult = await repo.createToken(requestedScope, ttl);

    // Strip ?expires= suffix from token for git credential use
    const tokenSecret = tokenResult.plaintext.split('?expires=')[0] || tokenResult.plaintext;

    // Prefer the stored project.repository as the clone URL: it is `created.remote`
    // captured at project creation and is exactly what the VM agent cloned, so its
    // host is guaranteed to match what git requests from the credential helper. The
    // Artifacts binding's `get().remote` has been observed to come back empty on
    // staging (unlike `create().remote`); when that happens an empty cloneUrl makes
    // the VM agent default the credential host to github.com, which then fails to
    // match the real Artifacts host and returns no credential (git fetch/push break).
    const cloneUrl = repositoryName || repo.remote || '';
    if (!repo.remote) {
      log.warn('workspace_git_token.artifacts_remote_empty', {
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        artifactsRepoId,
        usedStoredRepository: !!repositoryName,
        action: 'fell_back_to_stored_repository',
      });
    }
    if (!cloneUrl) {
      log.error('workspace_git_token.artifacts_clone_url_missing', {
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        artifactsRepoId,
        action: 'clone_url_empty',
      });
    }

    return callbackJsonWithJit(c, workspace, 'git_token', {
      token: tokenSecret,
      expiresAt: tokenResult.expiresAt ?? tokenResult.expires_at,
      cloneUrl,
      // The VM agent's credential helper answers with username "x" only for Cloudflare Artifacts
      // hosts it knows by name. For a bound self-hosted host, name it here so a refresh presents
      // the same username the clone used. Cloudflare responses are unchanged.
      ...(boundArtifactsRepositoryHost(cloneUrl) ? { username: 'x' } : {}),
    });
  }

  if (repoProvider === 'gitlab') {
    if (!workspace.projectId) {
      throw errors.forbidden('GitLab workspace has no project');
    }
    const metadata = await getProjectGitLabRepository(db, workspace.projectId);
    if (!metadata) {
      throw errors.forbidden('GitLab repository metadata is missing');
    }
    if (metadata.userId !== workspace.userId) {
      // The stored GitLab repo binding belongs to a different user than the
      // workspace owner — vending the owner's OAuth token against another
      // user's binding would cross a tenant boundary. Fail closed.
      log.error('workspace_git_token.gitlab_user_mismatch', {
        workspaceId: workspace.workspaceId,
        projectId: workspace.projectId,
        workspaceUserId: workspace.userId,
        metadataUserId: metadata.userId,
        action: 'rejected',
      });
      throw errors.forbidden('GitLab repository is not linked for this workspace owner');
    }
    await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'git_token');
    const tokenResult = await requireGitLabUserAccessTokenResultForOwner(
      c.env,
      workspace.userId,
      'workspace-git-token'
    );
    const verified = await verifyGitLabProjectAccess(
      c.env,
      tokenResult.accessToken,
      metadata.gitlabProjectId
    );
    if (
      verified.host !== metadata.host ||
      verified.gitlabProjectId !== metadata.gitlabProjectId ||
      verified.pathWithNamespace !== metadata.pathWithNamespace
    ) {
      throw errors.forbidden('GitLab repository access has changed; repository no longer matches');
    }

    return callbackJsonWithJit(c, workspace, 'git_token', {
      provider: 'gitlab',
      token: tokenResult.accessToken,
      expiresAt: tokenResult.accessTokenExpiresAt,
      cloneUrl: metadata.httpUrlToRepo,
      host: metadata.host,
      username: 'oauth2',
      repositoryPath: metadata.pathWithNamespace,
    });
  }

  // ─── GitHub token (existing flow) ──────────────────────────────────
  if (!workspace.installationId) {
    throw errors.notFound('Workspace has no GitHub installation');
  }
  // Scope the token to a single repo. Prefer the verified numeric repo ID; fall
  // back to the repository name for legacy projects created before github_repo_id
  // was backfilled (PR #1236). Both paths scope to exactly one repository, so the
  // personal-installation leak fix is preserved.
  const repoShortName =
    repositoryName && repositoryName.includes('/')
      ? (repositoryName.split('/').pop() ?? null)
      : repositoryName;
  if (!githubRepoId && !repoShortName) {
    throw errors.forbidden('GitHub repository is not verified for this workspace');
  }

  const installations = await db
    .select({
      installationId: schema.githubInstallations.installationId,
      externalInstallationId: schema.githubInstallations.externalInstallationId,
      userId: schema.githubInstallations.userId,
    })
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, workspace.installationId))
    .limit(1);

  const installation = installations[0];
  if (!installation) {
    log.warn('workspace_git_token_installation_owner_mismatch', {
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      installationRowId: workspace.installationId,
      expectedUserId: workspace.userId,
      action: 'rejected',
    });
    throw errors.notFound('GitHub installation');
  }
  if (installation.userId !== workspace.userId) {
    log.info('workspace_git_token_project_installation_shared', {
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      installationRowId: workspace.installationId,
      workspaceUserId: workspace.userId,
      installationOwnerUserId: installation.userId,
      action: 'allowed_after_user_access_verification',
    });
  }

  if (!repositoryName) {
    throw errors.forbidden('GitHub repository is not verified for this workspace');
  }

  const verifiedRepoId = await verifyWorkspaceGitHubOwnerAccess({
    env: c.env,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    userId: workspace.userId,
    repository: repositoryName,
    externalInstallationId: getExternalInstallationId(installation),
    githubRepoId,
  });

  // Lazy self-heal: legacy projects created before the numeric repo id was
  // captured have github_repo_id = null. Fetch + persist it now, BEFORE policy
  // resolution, so custom GitHub CLI policies (which require the numeric id) work
  // and scoping uses the rename-stable repositoryIds path. On any failure we fall
  // through to the name-based fallback below (no regression).
  if (!githubRepoId && repositoryName && workspace.projectId) {
    await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'git_token');
    const backfill = await backfillProjectGithubRepoId(db, c.env, {
      projectId: workspace.projectId,
      repository: repositoryName,
      externalInstallationId: getExternalInstallationId(installation),
    });
    if (backfill.githubRepoId) {
      githubRepoId = backfill.githubRepoId;
    }
  }
  githubRepoId ??= verifiedRepoId;

  let tokenOptions = null;
  try {
    tokenOptions = await resolveWorkspaceGitHubTokenOptions(db, {
      workspaceId: workspace.workspaceId,
      userId: workspace.userId,
      githubRepoId,
    });
  } catch (err) {
    if (err instanceof GitHubCliPolicyError) {
      throw errors.forbidden('GitHub CLI policy prevents token minting');
    }
    throw err;
  }
  // Additional Repository Access: same-installation repos selected in Project
  // Settings. Re-verified at this boundary; revoked/inaccessible entries are
  // dropped from the scope. Primary repo is always included implicitly.
  const additionalRepoIds =
    githubRepoId && workspace.projectId
      ? await resolveAdditionalRepositoryIds({
          env: c.env,
          db,
          workspaceId: workspace.workspaceId,
          projectId: workspace.projectId,
          userId: workspace.userId,
          externalInstallationId: getExternalInstallationId(installation),
        })
      : [];

  const scopedTokenOptions = {
    ...tokenOptions,
    ...(githubRepoId
      ? { repositoryIds: [githubRepoId, ...additionalRepoIds.filter((id) => id !== githubRepoId)] }
      : { repositories: [repoShortName as string] }),
  };
  await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'git_token');
  const token = await getInstallationToken(
    getExternalInstallationId(installation),
    c.env,
    scopedTokenOptions
  );
  return callbackJsonWithJit(c, workspace, 'git_token', {
    token: token.token,
    expiresAt: token.expiresAt,
  });
});

export { runtimeRoutes as gitTokenRoutes };
