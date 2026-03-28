import { drizzle } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import type { ProjectRuntimeConfigResponse } from '@simple-agent-manager/shared';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { errors } from '../../middleware/error';
import { getInstallationRepositories } from '../../services/github-app';

export function normalizeProjectName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
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
      .where(
        and(
          eq(schema.projectRuntimeEnvVars.projectId, project.id),
          eq(schema.projectRuntimeEnvVars.userId, project.userId)
        )
      )
      .orderBy(schema.projectRuntimeEnvVars.envKey),
    db
      .select()
      .from(schema.projectRuntimeFiles)
      .where(
        and(
          eq(schema.projectRuntimeFiles.projectId, project.id),
          eq(schema.projectRuntimeFiles.userId, project.userId)
        )
      )
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

export async function assertRepositoryAccess(
  installationExternalId: string,
  repository: string,
  env: Env
): Promise<void> {
  const repositories = await getInstallationRepositories(installationExternalId, env);
  const hasAccess = repositories.some((repo) => repo.fullName.toLowerCase() === repository);
  if (!hasAccess) {
    throw errors.forbidden('Repository is not accessible through the selected installation');
  }
}
