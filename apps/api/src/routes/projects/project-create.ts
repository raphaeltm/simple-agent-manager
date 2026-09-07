import type { RepoProvider } from '@simple-agent-manager/shared';
import { ARTIFACTS_DEFAULTS } from '@simple-agent-manager/shared';
import { and, count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toProjectResponse } from '../../lib/mappers';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { createOwnerProjectMembership } from '../../middleware/project-auth';
import { CreateProjectSchema, jsonValidator } from '../../schemas';
import { seedArtifactsReadme } from '../../services/artifacts/seed-readme';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import {
  listGitLabBranches,
  requireGitLabUserAccessToken,
  verifyGitLabProjectAccess,
} from '../../services/gitlab';
import { getRuntimeLimits } from '../../services/limits';
import {
  assertRepositoryAccess,
  isValidRepositoryFormat,
  normalizeProjectName,
  normalizeRepository,
  requireGitHubUserAccessToken,
  requireOwnedInstallation,
  toArtifactsRepoName,
} from './_helpers';

export function registerProjectCreateRoute(crudRoutes: Hono<{ Bindings: Env }>): void {
  crudRoutes.post('/', jsonValidator(CreateProjectSchema), async (c) => {
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    const limits = getRuntimeLimits(c.env);
    const body = c.req.valid('json');

    const name = body.name?.trim();
    const repoProvider: RepoProvider =
      body.repoProvider === 'artifacts'
        ? 'artifacts'
        : body.repoProvider === 'gitlab'
          ? 'gitlab'
          : 'github';
    const description = body.description?.trim() || null;

    if (!name) {
      throw errors.badRequest('name is required');
    }

    // Check project count limit
    const [projectCountRow] = await db
      .select({ count: count() })
      .from(schema.projects)
      .where(eq(schema.projects.userId, userId));

    if ((projectCountRow?.count ?? 0) >= limits.maxProjectsPerUser) {
      throw errors.badRequest(`Maximum ${limits.maxProjectsPerUser} projects allowed`);
    }

    // Check duplicate project name
    const normalizedName = normalizeProjectName(name);
    const duplicateNameRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(eq(schema.projects.userId, userId), eq(schema.projects.normalizedName, normalizedName))
      )
      .limit(1);
    if (duplicateNameRows[0]) {
      throw errors.conflict('Project name must be unique per user');
    }

    const now = new Date().toISOString();
    const projectId = ulid();

    if (repoProvider === 'artifacts') {
      // ─── Artifacts-backed project ───────────────────────────────────────
      const artifactsEnabled = c.env.ARTIFACTS_ENABLED === 'true';
      if (!artifactsEnabled) {
        throw errors.badRequest('Artifacts repo provider is not enabled');
      }
      if (!c.env.ARTIFACTS) {
        throw errors.internal('Artifacts binding is not configured');
      }

      // Check per-user Artifacts repo limit
      const maxRepos =
        parseInt(c.env.ARTIFACTS_MAX_REPOS_PER_USER || '', 10) ||
        ARTIFACTS_DEFAULTS.MAX_REPOS_PER_USER;
      const [artifactsCountRow] = await db
        .select({ count: count() })
        .from(schema.projects)
        .where(
          and(eq(schema.projects.userId, userId), eq(schema.projects.repoProvider, 'artifacts'))
        );
      if ((artifactsCountRow?.count ?? 0) >= maxRepos) {
        throw errors.badRequest(`Maximum ${maxRepos} Artifacts-backed projects allowed`);
      }

      const defaultBranch =
        body.defaultBranch?.trim() ||
        c.env.ARTIFACTS_DEFAULT_BRANCH ||
        ARTIFACTS_DEFAULTS.DEFAULT_BRANCH;

      // Validate the branch name before it is embedded verbatim in the git
      // receive-pack pkt-line frame during seeding. Reject shell/control/protocol
      // metacharacters (spaces, newlines, NUL) — same guard as workspace creation.
      if (defaultBranch.length > 255 || !/^[a-zA-Z0-9._\-/]+$/.test(defaultBranch)) {
        throw errors.badRequest(
          'defaultBranch contains invalid characters. Only alphanumeric, hyphens, underscores, slashes, and dots are allowed (max 255 chars).'
        );
      }

      // Create Artifacts repo — name includes projectId for uniqueness.
      // Must be sanitized: Artifacts rejects uppercase/spaces (the ULID projectId
      // is uppercase and normalizedName preserves spaces).
      const repoName = toArtifactsRepoName(normalizedName, projectId);
      const created = await c.env.ARTIFACTS.create(repoName, {
        description: description || undefined,
        setDefaultBranch: defaultBranch,
      });

      // Seed an initial README commit so the repo has a real default-branch ref.
      // A freshly-created Artifacts repo is empty, and the VM agent bootstrap
      // clones with `git clone --branch <defaultBranch>` (bootstrap.go), which
      // fails against a repo whose default branch does not exist yet. The README
      // also orients agents (project name, description, SAM MCP tools). If seeding
      // fails the repo is unusable, so we abort creation and log the orphan.
      try {
        await seedArtifactsReadme({
          remote: created.remote,
          token: created.token,
          branch: defaultBranch,
          projectName: name,
          description,
        });
      } catch (seedError) {
        log.error('project_create.artifacts_seed_failed', {
          projectId,
          repoName: created.name,
          error: seedError instanceof Error ? seedError.message : String(seedError),
          action: 'orphaned_artifacts_repo',
        });
        // Best-effort cleanup: the repo exists but has no usable content, and no
        // project row will reference it. Delete it so it does not leak quota.
        try {
          await c.env.ARTIFACTS.delete(created.name);
        } catch (cleanupError) {
          log.error('project_create.artifacts_seed_cleanup_failed', {
            projectId,
            repoName: created.name,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            action: 'orphaned_artifacts_repo_cleanup_failed',
          });
        }
        throw errors.internal('Failed to initialize Artifacts repository');
      }

      // Store the full Artifacts clone URL as repository so normalizeRepoURL()
      // on the VM agent passes it through as-is (it handles https:// URLs correctly).
      const repository = created.remote;

      try {
        await db.insert(schema.projects).values({
          id: projectId,
          userId,
          name,
          normalizedName,
          description,
          installationId:
            c.env.TRIAL_ANONYMOUS_INSTALLATION_ID ?? 'system_anonymous_trials_installation',
          repository,
          defaultBranch,
          repoProvider: 'artifacts',
          artifactsRepoId: created.name,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
        await createOwnerProjectMembership(db, projectId, userId, userId, now);
      } catch (dbError) {
        // Log the orphaned Artifacts repo so it can be cleaned up manually.
        // The Artifacts API may not support repo deletion yet, so we log
        // enough detail for manual reconciliation.
        log.error('project_create.artifacts_db_insert_failed', {
          projectId,
          repoName: created.name,
          repository,
          error: dbError instanceof Error ? dbError.message : String(dbError),
          action: 'orphaned_artifacts_repo',
        });
        throw dbError;
      }
    } else if (repoProvider === 'gitlab') {
      // ─── GitLab-backed project ────────────────────────────────────────
      const gitlabProjectId =
        typeof body.gitlabProjectId === 'number' ? body.gitlabProjectId : null;
      if (!gitlabProjectId || !Number.isFinite(gitlabProjectId) || gitlabProjectId <= 0) {
        throw errors.badRequest('gitlabProjectId is required for GitLab projects');
      }

      const accessToken = await requireGitLabUserAccessToken(c, userId);
      const metadata = await verifyGitLabProjectAccess(c.env, accessToken, gitlabProjectId);
      const selectedBranch = body.defaultBranch?.trim() || metadata.defaultBranch;
      if (selectedBranch.length > 255 || !/^[a-zA-Z0-9._\-/]+$/.test(selectedBranch)) {
        throw errors.badRequest(
          'defaultBranch contains invalid characters. Only alphanumeric, hyphens, underscores, slashes, and dots are allowed (max 255 chars).'
        );
      }
      if (selectedBranch !== metadata.defaultBranch) {
        const branches = await listGitLabBranches(c.env, accessToken, gitlabProjectId);
        if (!branches.some((branch) => branch.name === selectedBranch)) {
          throw errors.badRequest('Selected GitLab branch does not exist');
        }
      }

      const duplicateRows = await db
        .select({ id: schema.projectGitlabRepositories.id })
        .from(schema.projectGitlabRepositories)
        .where(
          and(
            eq(schema.projectGitlabRepositories.userId, userId),
            eq(schema.projectGitlabRepositories.host, metadata.host),
            eq(schema.projectGitlabRepositories.gitlabProjectId, metadata.gitlabProjectId)
          )
        )
        .limit(1);
      if (duplicateRows[0]) {
        throw errors.conflict('A project with this GitLab repository already exists');
      }

      await db.insert(schema.projects).values({
        id: projectId,
        userId,
        name,
        normalizedName,
        description,
        installationId:
          c.env.TRIAL_ANONYMOUS_INSTALLATION_ID ?? 'system_anonymous_trials_installation',
        repository: metadata.pathWithNamespace,
        defaultBranch: selectedBranch,
        repoProvider: 'gitlab',
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });

      try {
        await db.insert(schema.projectGitlabRepositories).values({
          id: ulid(),
          projectId,
          userId,
          host: metadata.host,
          gitlabProjectId: metadata.gitlabProjectId,
          pathWithNamespace: metadata.pathWithNamespace,
          webUrl: metadata.webUrl,
          httpUrlToRepo: metadata.httpUrlToRepo,
          defaultBranch: selectedBranch,
          createdAt: now,
          updatedAt: now,
        });
        await createOwnerProjectMembership(db, projectId, userId, userId, now);
      } catch (dbError) {
        await db.delete(schema.projects).where(eq(schema.projects.id, projectId));
        throw dbError;
      }
    } else {
      // ─── GitHub-backed project (existing flow) ──────────────────────────
      const installationId = body.installationId?.trim();
      const repository = normalizeRepository(body.repository ?? '');
      const defaultBranch = body.defaultBranch?.trim();
      const githubRepoId = typeof body.githubRepoId === 'number' ? body.githubRepoId : null;
      const githubRepoNodeId = body.githubRepoNodeId?.trim() || null;

      if (!installationId || !repository || !defaultBranch) {
        throw errors.badRequest(
          'installationId, repository, and defaultBranch are required for GitHub projects'
        );
      }

      if (!isValidRepositoryFormat(repository)) {
        throw errors.badRequest('repository must be in owner/repo format');
      }

      const installation = await requireOwnedInstallation(db, installationId, userId);
      const externalInstallationId = getExternalInstallationId(installation);
      const accessToken = await requireGitHubUserAccessToken(c, userId);
      const verifiedRepo = await assertRepositoryAccess(
        accessToken,
        externalInstallationId,
        repository,
        userId
      );
      if (githubRepoId !== null && githubRepoId !== verifiedRepo.id) {
        throw errors.forbidden('GitHub repository ID does not match the selected repository');
      }
      if (
        githubRepoNodeId !== null &&
        verifiedRepo.nodeId !== null &&
        githubRepoNodeId !== verifiedRepo.nodeId
      ) {
        throw errors.forbidden('GitHub repository node ID does not match the selected repository');
      }
      const storedGitHubRepoId = verifiedRepo.id;
      const storedGitHubRepoNodeId = verifiedRepo.nodeId;

      const duplicateRepositoryRows = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.userId, userId),
            eq(schema.projects.installationId, installation.id),
            eq(schema.projects.repository, repository)
          )
        )
        .limit(1);
      if (duplicateRepositoryRows[0]) {
        throw errors.conflict('Project repository is already linked');
      }

      const duplicateRepoIdRows = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.userId, userId),
            eq(schema.projects.githubRepoId, storedGitHubRepoId)
          )
        )
        .limit(1);
      if (duplicateRepoIdRows[0]) {
        throw errors.conflict('A project with this GitHub repository ID already exists');
      }

      await db.insert(schema.projects).values({
        id: projectId,
        userId,
        name,
        normalizedName,
        description,
        installationId: installation.id,
        repository,
        defaultBranch,
        repoProvider: 'github',
        githubRepoId: storedGitHubRepoId,
        githubRepoNodeId: storedGitHubRepoNodeId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      });
      await createOwnerProjectMembership(db, projectId, userId, userId, now);
    }

    const rows = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);

    const project = rows[0];
    if (!project) {
      throw errors.internal('Failed to load created project');
    }

    return c.json(toProjectResponse(project), 201);
  });
}
