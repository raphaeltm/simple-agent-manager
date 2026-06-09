import type {
  AvailableRepositoriesResponse,
  AvailableRepository,
  ProjectRepository,
  ProjectRepositoryAccessResponse,
  ProjectRepositoryStatus,
  SubmoduleDiscoveryResponse,
  SubmoduleSuggestion,
} from '@simple-agent-manager/shared';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { AddProjectRepositorySchema, jsonValidator } from '../../schemas';
import {
  getRepositoryGitmodules,
  getUserInstallationRepositories,
  type GitHubRepositoryAccess,
} from '../../services/github-app';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import { getRuntimeLimits } from '../../services/limits';
import {
  assertRepositoryAccess,
  isValidRepositoryFormat,
  normalizeRepository,
  requireGitHubUserAccessToken,
  requireOwnedInstallation,
} from './_helpers';

const repositoryAccessRoutes = new Hono<{ Bindings: Env }>();

function toRepositoryResponse(
  row: schema.ProjectGithubRepository,
  status: ProjectRepositoryStatus
): ProjectRepository {
  return {
    id: row.id,
    repository: row.repository,
    githubRepoId: row.githubRepoId,
    githubRepoNodeId: row.githubRepoNodeId,
    status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Fetch the set of repositories the user can access through the project's
 * installation (user∩app), keyed by lowercased full name. Returns null when the
 * accessible set cannot be determined (installation removed, user token
 * unavailable) so callers can fall back to a degraded status instead of throwing.
 */
async function tryGetAccessibleRepoNames(
  c: { env: Env; req: { raw: Request } } & Parameters<typeof requireGitHubUserAccessToken>[0],
  db: ReturnType<typeof drizzle<typeof schema>>,
  project: schema.Project,
  userId: string
): Promise<Set<string> | null> {
  try {
    const installation = await requireOwnedInstallation(db, project.installationId, userId);
    const externalInstallationId = getExternalInstallationId(installation);
    const accessToken = await requireGitHubUserAccessToken(c, userId);
    const repositories = await getUserInstallationRepositories(
      accessToken,
      externalInstallationId,
      {
        flow: 'project-access',
        userId,
        installationId: externalInstallationId,
        repository: project.repository,
      }
    );
    return new Set(repositories.map((r) => r.fullName.toLowerCase()));
  } catch (err) {
    log.warn('repository_access.status_check_unavailable', {
      projectId: project.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the owned GitHub-backed project plus its external installation id for a
 * repository-access route. Throws a 400 (with the caller-supplied message) for
 * non-GitHub projects. Shared by the `available` and `discover` handlers.
 */
async function resolveGitHubProjectContext(
  c: Context<{ Bindings: Env }>,
  nonGithubMessage: string
): Promise<{
  userId: string;
  db: ReturnType<typeof drizzle<typeof schema>>;
  project: schema.Project;
  externalInstallationId: string;
}> {
  const userId = getUserId(c);
  const projectId = c.req.param('id') ?? '';
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireOwnedProject(db, projectId, userId);

  if (project.repoProvider && project.repoProvider !== 'github') {
    throw errors.badRequest(nonGithubMessage);
  }

  const installation = await requireOwnedInstallation(db, project.installationId, userId);
  const externalInstallationId = getExternalInstallationId(installation);
  return { userId, db, project, externalInstallationId };
}

/** GET /:id/repository-access — list additional repositories with live status. */
repositoryAccessRoutes.get('/:id/repository-access', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireOwnedProject(db, projectId, userId);

  const rows = await db
    .select()
    .from(schema.projectGithubRepositories)
    .where(
      and(
        eq(schema.projectGithubRepositories.projectId, project.id),
        eq(schema.projectGithubRepositories.userId, userId)
      )
    )
    .orderBy(schema.projectGithubRepositories.repository);

  const accessible =
    rows.length > 0 ? await tryGetAccessibleRepoNames(c, db, project, userId) : null;

  const repositories = rows.map((row) => {
    let status: ProjectRepositoryStatus = 'active';
    if (accessible !== null && !accessible.has(row.repository.toLowerCase())) {
      status = 'access-revoked';
    }
    return toRepositoryResponse(row, status);
  });

  const response: ProjectRepositoryAccessResponse = {
    primaryRepository: project.repository,
    repositories,
  };
  return c.json(response);
});

/** POST /:id/repository-access — add an additional same-installation repository. */
repositoryAccessRoutes.post(
  '/:id/repository-access',
  jsonValidator(AddProjectRepositorySchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    const body = c.req.valid('json');
    const limits = getRuntimeLimits(c.env);

    const project = await requireOwnedProject(db, projectId, userId);
    if (project.repoProvider && project.repoProvider !== 'github') {
      throw errors.badRequest('Repository access is only supported for GitHub-backed projects');
    }

    const repository = normalizeRepository(body.repository ?? '');
    if (!isValidRepositoryFormat(repository)) {
      throw errors.badRequest('repository must be in owner/repo format');
    }
    if (repository === normalizeRepository(project.repository)) {
      throw errors.badRequest('The primary project repository is always included implicitly');
    }

    const existing = await db
      .select({ id: schema.projectGithubRepositories.id })
      .from(schema.projectGithubRepositories)
      .where(
        and(
          eq(schema.projectGithubRepositories.projectId, project.id),
          eq(schema.projectGithubRepositories.repository, repository)
        )
      )
      .limit(1);
    if (existing[0]) {
      throw errors.conflict('Repository is already in this project');
    }

    const countRows = await db
      .select({ count: count() })
      .from(schema.projectGithubRepositories)
      .where(
        and(
          eq(schema.projectGithubRepositories.projectId, project.id),
          eq(schema.projectGithubRepositories.userId, userId)
        )
      );
    if ((countRows[0]?.count ?? 0) >= limits.maxProjectGithubReposPerProject) {
      throw errors.badRequest(
        `Maximum ${limits.maxProjectGithubReposPerProject} additional repositories allowed per project`
      );
    }

    // Verify user∩app access for the repository BEFORE storing it.
    const installation = await requireOwnedInstallation(db, project.installationId, userId);
    const externalInstallationId = getExternalInstallationId(installation);
    const accessToken = await requireGitHubUserAccessToken(c, userId);
    const verifiedRepo = await assertRepositoryAccess(
      accessToken,
      externalInstallationId,
      repository,
      userId
    );

    const now = new Date().toISOString();
    await db.insert(schema.projectGithubRepositories).values({
      id: ulid(),
      projectId: project.id,
      userId,
      repository,
      githubRepoId: verifiedRepo.id,
      githubRepoNodeId: verifiedRepo.nodeId,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db
      .select()
      .from(schema.projectGithubRepositories)
      .where(
        and(
          eq(schema.projectGithubRepositories.projectId, project.id),
          eq(schema.projectGithubRepositories.userId, userId)
        )
      )
      .orderBy(schema.projectGithubRepositories.repository);

    const response: ProjectRepositoryAccessResponse = {
      primaryRepository: project.repository,
      repositories: rows.map((row) => toRepositoryResponse(row, 'active')),
    };
    return c.json(response, 201);
  }
);

/** DELETE /:id/repository-access/:repoRowId — remove an additional repository. */
repositoryAccessRoutes.delete('/:id/repository-access/:repoRowId', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const repoRowId = c.req.param('repoRowId');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireOwnedProject(db, projectId, userId);

  const existing = await db
    .select({ id: schema.projectGithubRepositories.id })
    .from(schema.projectGithubRepositories)
    .where(
      and(
        eq(schema.projectGithubRepositories.id, repoRowId),
        eq(schema.projectGithubRepositories.projectId, project.id),
        eq(schema.projectGithubRepositories.userId, userId)
      )
    )
    .limit(1);
  if (!existing[0]) {
    throw errors.notFound('Repository');
  }

  await db
    .delete(schema.projectGithubRepositories)
    .where(eq(schema.projectGithubRepositories.id, repoRowId));

  const rows = await db
    .select()
    .from(schema.projectGithubRepositories)
    .where(
      and(
        eq(schema.projectGithubRepositories.projectId, project.id),
        eq(schema.projectGithubRepositories.userId, userId)
      )
    )
    .orderBy(schema.projectGithubRepositories.repository);

  const response: ProjectRepositoryAccessResponse = {
    primaryRepository: project.repository,
    repositories: rows.map((row) => toRepositoryResponse(row, 'active')),
  };
  return c.json(response);
});

/** GET /:id/repository-access/available — list installation repos selectable for this project.
 *  Returns the live user∩app intersection minus the primary repository and any
 *  repositories already added to the project's repository-access set. */
repositoryAccessRoutes.get('/:id/repository-access/available', async (c) => {
  const { userId, db, project, externalInstallationId } = await resolveGitHubProjectContext(
    c,
    'Repository access is only supported for GitHub-backed projects'
  );
  const accessToken = await requireGitHubUserAccessToken(c, userId);
  const repositories: GitHubRepositoryAccess[] = await getUserInstallationRepositories(
    accessToken,
    externalInstallationId,
    {
      flow: 'project-access',
      userId,
      installationId: externalInstallationId,
      repository: project.repository,
    }
  );

  const addedRows = await db
    .select({ repository: schema.projectGithubRepositories.repository })
    .from(schema.projectGithubRepositories)
    .where(
      and(
        eq(schema.projectGithubRepositories.projectId, project.id),
        eq(schema.projectGithubRepositories.userId, userId)
      )
    );
  const excluded = new Set(addedRows.map((r) => r.repository.toLowerCase()));
  excluded.add(normalizeRepository(project.repository).toLowerCase());

  const available: AvailableRepository[] = repositories
    .filter((repo) => !excluded.has(repo.fullName.toLowerCase()))
    .map((repo) => ({
      repository: repo.fullName,
      githubRepoId: repo.id,
      githubRepoNodeId: repo.nodeId,
      private: repo.private,
    }))
    .sort((a, b) => a.repository.localeCompare(b.repository));

  const response: AvailableRepositoriesResponse = { repositories: available };
  return c.json(response);
});

/** GET /:id/repository-access/discover — suggest repos from the primary repo's `.gitmodules`. */
repositoryAccessRoutes.get('/:id/repository-access/discover', async (c) => {
  const { userId, db, project, externalInstallationId } = await resolveGitHubProjectContext(
    c,
    'Submodule discovery is only supported for GitHub-backed projects'
  );
  const [parentOwner, parentRepo] = project.repository.split('/');
  if (!parentOwner || !parentRepo) {
    throw errors.badRequest('Project repository is malformed');
  }

  const gitmodules = await getRepositoryGitmodules(
    externalInstallationId,
    parentOwner,
    parentRepo,
    parentOwner,
    c.env,
    project.defaultBranch
  );

  // Determine which discovered repos are accessible through the installation and
  // which are already added, in a single fetch each.
  const accessToken = await requireGitHubUserAccessToken(c, userId);
  let accessibleNames = new Set<string>();
  try {
    const repositories: GitHubRepositoryAccess[] = await getUserInstallationRepositories(
      accessToken,
      externalInstallationId,
      {
        flow: 'project-access',
        userId,
        installationId: externalInstallationId,
        repository: project.repository,
      }
    );
    accessibleNames = new Set(repositories.map((r) => r.fullName.toLowerCase()));
  } catch (err) {
    log.warn('repository_access.discover_accessible_unavailable', {
      projectId: project.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const addedRows = await db
    .select({ repository: schema.projectGithubRepositories.repository })
    .from(schema.projectGithubRepositories)
    .where(
      and(
        eq(schema.projectGithubRepositories.projectId, project.id),
        eq(schema.projectGithubRepositories.userId, userId)
      )
    );
  const addedNames = new Set(addedRows.map((r) => r.repository.toLowerCase()));
  const primaryName = project.repository.toLowerCase();

  const suggestions: SubmoduleSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of gitmodules) {
    // Unsupported (non-GitHub or unparseable) submodule URL.
    if (!entry.repository) {
      suggestions.push({
        repository: entry.path,
        path: entry.path,
        accessible: false,
        alreadyAdded: false,
      });
      continue;
    }
    const name = entry.repository.toLowerCase();
    if (name === primaryName || seen.has(name)) continue;
    seen.add(name);
    suggestions.push({
      repository: entry.repository,
      path: entry.path,
      accessible: accessibleNames.has(name),
      alreadyAdded: addedNames.has(name),
    });
  }

  const response: SubmoduleDiscoveryResponse = { suggestions };
  return c.json(response);
});

export { repositoryAccessRoutes };
