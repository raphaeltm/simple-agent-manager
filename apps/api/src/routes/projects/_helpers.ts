import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { AppError, errors } from '../../middleware/error';
import {
  getUserInstallationRepositories,
  type GitHubRepositoryAccess,
} from '../../services/github-app';
import { getExternalInstallationId } from '../../services/github-installation-ids';
import {
  getGitHubUserAccessToken,
  getGitHubUserAccessTokenForOwner,
} from '../../services/github-user-access-token';
import {
  getProjectGitLabRepository,
  requireGitLabUserAccessToken,
  requireGitLabUserAccessTokenForOwner,
  verifyGitLabProjectAccess,
} from '../../services/gitlab';

export function normalizeProjectName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Builds a valid Cloudflare Artifacts repository name from a project name and
 * projectId. Artifacts rejects names containing uppercase letters, spaces, or
 * other non `[a-z0-9-]` characters ("Invalid repo name"). The projectId is a
 * ULID (uppercase Crockford base32) and `normalizeProjectName` preserves
 * spaces, so the raw `${name}-${projectId}` is always invalid. This lowercases
 * and hyphen-sanitizes both parts, collapses/trims hyphens, and caps the name
 * component so the full name stays comfortably short. The projectId (lowercased,
 * still unique) is always preserved for repo uniqueness.
 */
export function toArtifactsRepoName(projectName: string, projectId: string): string {
  const sanitize = (value: string): string =>
    value
      .toLowerCase()
      // Collapse every run of non-alphanumerics (spaces, symbols, existing
      // hyphens) into a single hyphen, then trim a single leading/trailing one.
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const namePart = sanitize(projectName).slice(0, 30).replace(/-$/, '');
  const idPart = sanitize(projectId);
  return namePart ? `${namePart}-${idPart}` : `repo-${idPart}`;
}

export function normalizeRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

export function isValidRepositoryFormat(repository: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(repository);
}

export const PROJECT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PROJECT_FILE_PATH_PATTERN = /^[^\\:*?"<>|]+$/;
const textEncoder = new TextEncoder();

export function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * Allowed absolute path prefixes for runtime files.
 * Only paths under user home directories are permitted inside the devcontainer.
 * System paths (/etc, /usr, /var, etc.) are blocked to prevent privilege escalation.
 */
export const ALLOWED_ABSOLUTE_PREFIXES = ['/home/node/', '/home/user/'];

/**
 * Blocked ~ (home-relative) paths that could enable persistence or privilege escalation.
 */
export const BLOCKED_HOME_PATHS = [
  '~/.ssh/authorized_keys',
  '~/.ssh/authorized_keys2',
  '~/.ssh/rc',
  '~/.ssh/environment',
];

/**
 * Permissive path normalization for read-only file proxy routes (chat file viewer).
 * Prevents path traversal (..) but allows any absolute path — users have full access
 * to their dev containers and should be able to view any file.
 */
export function normalizeFileProxyPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    throw errors.badRequest('path is required');
  }
  if (!PROJECT_FILE_PATH_PATTERN.test(normalized)) {
    throw errors.badRequest('path contains invalid characters');
  }

  const segments = normalized.split('/');
  const checkSegments = normalized.startsWith('/') ? segments.slice(1) : segments;
  const startIdx = checkSegments[0] === '~' ? 1 : 0;
  if (checkSegments.length === 1 && checkSegments[0] === '.') {
    return '.';
  }
  for (let i = startIdx; i < checkSegments.length; i++) {
    const seg = checkSegments[i];
    if (seg === '' || seg === '.' || seg === '..') {
      throw errors.badRequest('path must not contain empty, dot, or dot-dot segments');
    }
  }

  return segments.join('/');
}

export function normalizeProjectFilePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    throw errors.badRequest('path is required');
  }
  if (!PROJECT_FILE_PATH_PATTERN.test(normalized)) {
    throw errors.badRequest('path contains invalid characters');
  }

  const segments = normalized.split('/');
  // For absolute paths, the first segment will be empty (from leading /). Skip it.
  const checkSegments = normalized.startsWith('/') ? segments.slice(1) : segments;
  // Allow ~ as the first segment for home directory expansion
  const startIdx = checkSegments[0] === '~' ? 1 : 0;
  // Allow bare "." as a root-directory alias, but reject it as a mid-path segment
  if (checkSegments.length === 1 && checkSegments[0] === '.') {
    return '.';
  }
  for (let i = startIdx; i < checkSegments.length; i++) {
    const seg = checkSegments[i];
    if (seg === '' || seg === '.' || seg === '..') {
      throw errors.badRequest('path must not contain empty, dot, or dot-dot segments');
    }
  }

  // Block absolute paths outside allowed prefixes (prevents /etc/cron.d, /etc/profile.d, etc.)
  if (normalized.startsWith('/')) {
    const allowed = ALLOWED_ABSOLUTE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
    if (!allowed) {
      throw errors.badRequest(
        'Absolute paths are only allowed under /home/node/ or /home/user/. ' +
          'Use a relative path or ~/... for home directory files.'
      );
    }
  }

  // Block dangerous home-relative paths (prevents SSH key injection, etc.)
  if (normalized.startsWith('~')) {
    const blocked = BLOCKED_HOME_PATHS.some((p) => normalized === p);
    if (blocked) {
      throw errors.badRequest(`Path ${normalized} is not allowed for security reasons`);
    }
  }

  return segments.join('/');
}

export async function buildProjectRuntimeConfigResponse(
  db: ReturnType<typeof drizzle<typeof schema>>,
  project: schema.Project
): Promise<ProjectRuntimeConfigResponse> {
  const [envRows, fileRows] = await Promise.all([
    db
      .select()
      .from(schema.projectRuntimeEnvVars)
      .where(eq(schema.projectRuntimeEnvVars.projectId, project.id))
      .orderBy(schema.projectRuntimeEnvVars.envKey),
    db
      .select()
      .from(schema.projectRuntimeFiles)
      .where(eq(schema.projectRuntimeFiles.projectId, project.id))
      .orderBy(schema.projectRuntimeFiles.filePath),
  ]);

  const envVars: ProjectRuntimeConfigResponse['envVars'] = [];
  for (const row of envRows) {
    let value: string | null = row.storedValue;
    if (row.isSecret) {
      value = null;
    }
    envVars.push({
      key: row.envKey,
      value,
      isSecret: row.isSecret,
      hasValue: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  const files: ProjectRuntimeConfigResponse['files'] = [];
  for (const row of fileRows) {
    let content: string | null = row.storedContent;
    if (row.isSecret) {
      content = null;
    }
    files.push({
      path: row.filePath,
      content,
      isSecret: row.isSecret,
      hasValue: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return { envVars, files };
}

export async function requireOwnedInstallation(
  db: ReturnType<typeof drizzle<typeof schema>>,
  installationRowId: string,
  userId: string
): Promise<schema.GitHubInstallation> {
  const rows = await db
    .select()
    .from(schema.githubInstallations)
    .where(
      and(
        eq(schema.githubInstallations.id, installationRowId),
        eq(schema.githubInstallations.userId, userId)
      )
    )
    .limit(1);

  const installation = rows[0];
  if (!installation) {
    throw errors.notFound('Installation');
  }

  return installation;
}

export async function requireProjectInstallation(
  db: ReturnType<typeof drizzle<typeof schema>>,
  installationRowId: string
): Promise<schema.GitHubInstallation> {
  const rows = await db
    .select()
    .from(schema.githubInstallations)
    .where(eq(schema.githubInstallations.id, installationRowId))
    .limit(1);

  const installation = rows[0];
  if (!installation) {
    throw errors.notFound('Installation');
  }

  return installation;
}

export async function assertRepositoryAccess(
  accessToken: string,
  installationExternalId: string,
  repository: string,
  userId: string,
  flow: 'project-access' | 'branches' = 'project-access'
): Promise<GitHubRepositoryAccess> {
  const repositories = await getUserInstallationRepositories(accessToken, installationExternalId, {
    flow,
    userId,
    installationId: installationExternalId,
    repository,
  });
  const normalizedRepository = repository.toLowerCase();
  const matchedRepo = repositories.find(
    (repo) => repo.fullName.toLowerCase() === normalizedRepository
  );
  if (!matchedRepo) {
    throw errors.forbidden('Repository is not accessible through the selected installation');
  }
  return matchedRepo;
}

/**
 * Resolve the authenticated user's GitHub OAuth access token, failing fast if
 * it is unavailable. BetterAuth owns the underlying token refresh/encryption;
 * a null result means the user has no usable GitHub authorization.
 */
export async function requireGitHubUserAccessToken(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<string> {
  const accessToken = await getGitHubUserAccessToken(c, userId);
  if (!accessToken) {
    throw new AppError(
      401,
      'GITHUB_REAUTH_REQUIRED',
      'Your GitHub authorization has expired — please sign out and back in'
    );
  }
  return accessToken;
}

/**
 * Fail-fast user∩app GitHub repo-access gate for spawn paths.
 *
 * Every GitHub action must be authorized by the intersection of (a) what the
 * GitHub app installation grants AND (b) what the user's own GitHub
 * authorization allows. The create/update paths already enforce this; this
 * helper re-verifies it at workspace/task spawn BEFORE any machine is
 * provisioned or any clone is attempted, so a user removed from an org/repo
 * after project creation cannot spawn workspaces that clone the repo via the
 * app-installation token.
 *
 * Throws 403 (forbidden) — without side effects — if the user no longer has
 * access to the bound repository, or if the verified repository id has drifted
 * from the project's bound `githubRepoId`.
 *
 * Same bug class as the production leak fixed in PR #1236 (5be1ea96) and
 * PR #1238 (b8e42783).
 */
export async function requireRepositoryUserAccess(
  c: Context<{ Bindings: Env }>,
  db: ReturnType<typeof drizzle<typeof schema>>,
  project: schema.Project,
  userId: string
): Promise<void> {
  // Artifacts-backed projects have no external user repository to intersect
  // against — they are out of scope for this gate.
  if (project.repoProvider === 'artifacts') {
    return;
  }
  if (project.repoProvider === 'gitlab') {
    const metadata = await getProjectGitLabRepository(db, project.id);
    if (!metadata) {
      throw errors.forbidden('GitLab repository metadata is missing');
    }
    const accessToken = await requireGitLabUserAccessToken(c, userId);
    const verified = await verifyGitLabProjectAccess(c.env, accessToken, metadata.gitlabProjectId);
    if (
      verified.host !== metadata.host ||
      verified.gitlabProjectId !== metadata.gitlabProjectId ||
      verified.pathWithNamespace !== metadata.pathWithNamespace
    ) {
      throw errors.forbidden('GitLab repository access has changed; repository no longer matches');
    }
    return;
  }
  if (project.repoProvider && project.repoProvider !== 'github') {
    throw errors.forbidden('Unsupported repository provider');
  }

  const installation = await requireProjectInstallation(db, project.installationId);
  const externalInstallationId = getExternalInstallationId(installation);
  const accessToken = await requireGitHubUserAccessToken(c, userId);
  const verifiedRepo = await assertRepositoryAccess(
    accessToken,
    externalInstallationId,
    project.repository,
    userId
  );
  if (project.githubRepoId !== null && verifiedRepo.id !== project.githubRepoId) {
    throw errors.forbidden('GitHub repository access has changed; repository ID no longer matches');
  }
}

export async function requireRepositoryOwnerAccess(
  env: Env,
  db: ReturnType<typeof drizzle<typeof schema>>,
  project: schema.Project,
  userId: string,
  flow = 'owner-preflight'
): Promise<void> {
  if (project.repoProvider === 'artifacts') {
    return;
  }
  if (project.repoProvider === 'gitlab') {
    const metadata = await getProjectGitLabRepository(db, project.id);
    if (!metadata) {
      throw errors.forbidden('GitLab repository metadata is missing');
    }
    const accessToken = await requireGitLabUserAccessTokenForOwner(env, userId, flow);
    const verified = await verifyGitLabProjectAccess(env, accessToken, metadata.gitlabProjectId);
    if (
      verified.host !== metadata.host ||
      verified.gitlabProjectId !== metadata.gitlabProjectId ||
      verified.pathWithNamespace !== metadata.pathWithNamespace
    ) {
      throw errors.forbidden('GitLab repository access has changed; repository no longer matches');
    }
    return;
  }
  if (project.repoProvider && project.repoProvider !== 'github') {
    throw errors.forbidden('Unsupported repository provider');
  }

  const installation = await requireOwnedInstallation(db, project.installationId, userId);
  const externalInstallationId = getExternalInstallationId(installation);
  const accessToken = await getGitHubUserAccessTokenForOwner(env, userId, flow);
  if (!accessToken) {
    throw new AppError(
      401,
      'GITHUB_REAUTH_REQUIRED',
      'Your GitHub authorization has expired — please sign out and back in'
    );
  }
  const verifiedRepo = await assertRepositoryAccess(
    accessToken,
    externalInstallationId,
    project.repository,
    userId
  );
  if (project.githubRepoId !== null && verifiedRepo.id !== project.githubRepoId) {
    throw errors.forbidden('GitHub repository access has changed; repository ID no longer matches');
  }
}
