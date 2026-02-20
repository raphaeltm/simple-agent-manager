import { Hono } from 'hono';
import { and, count, desc, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type {
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  ProjectDetailResponse,
  ProjectRuntimeConfigResponse,
  TaskStatus,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
  UpdateProjectRequest,
} from '@simple-agent-manager/shared';
import type { Env } from '../index';
import * as schema from '../db/schema';
import { ulid } from '../lib/ulid';
import { getUserId, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireOwnedProject } from '../middleware/project-auth';
import { getRuntimeLimits } from '../services/limits';
import { getInstallationRepositories } from '../services/github-app';
import { encrypt } from '../services/encryption';

const projectsRoutes = new Hono<{ Bindings: Env }>();

projectsRoutes.use('/*', requireAuth());

function normalizeProjectName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeRepository(repository: string): string {
  return repository.trim().toLowerCase();
}

function isValidRepositoryFormat(repository: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(repository);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const PROJECT_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECT_FILE_PATH_PATTERN = /^[^\\:*?"<>|]+$/;
const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function normalizeProjectFilePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    throw errors.badRequest('path is required');
  }
  if (normalized.startsWith('/')) {
    throw errors.badRequest('path must be relative');
  }
  if (!PROJECT_FILE_PATH_PATTERN.test(normalized)) {
    throw errors.badRequest('path contains invalid characters');
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw errors.badRequest('path must not contain empty, dot, or dot-dot segments');
  }

  return segments.join('/');
}

function toProjectResponse(project: schema.Project): Project {
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    description: project.description,
    installationId: project.installationId,
    repository: project.repository,
    defaultBranch: project.defaultBranch,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

async function buildProjectRuntimeConfigResponse(
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

async function requireOwnedInstallation(
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

async function assertRepositoryAccess(
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

projectsRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);
  const body = await c.req.json<CreateProjectRequest>();

  const name = body.name?.trim();
  const installationId = body.installationId?.trim();
  const repository = normalizeRepository(body.repository ?? '');
  const defaultBranch = body.defaultBranch?.trim();
  const description = body.description?.trim() || null;

  if (!name || !installationId || !repository || !defaultBranch) {
    throw errors.badRequest('name, installationId, repository, and defaultBranch are required');
  }

  if (!isValidRepositoryFormat(repository)) {
    throw errors.badRequest('repository must be in owner/repo format');
  }

  const [projectCountRow] = await db
    .select({ count: count() })
    .from(schema.projects)
    .where(eq(schema.projects.userId, userId));

  if ((projectCountRow?.count ?? 0) >= limits.maxProjectsPerUser) {
    throw errors.badRequest(`Maximum ${limits.maxProjectsPerUser} projects allowed`);
  }

  const installation = await requireOwnedInstallation(db, installationId, userId);
  await assertRepositoryAccess(installation.installationId, repository, c.env);

  const normalizedName = normalizeProjectName(name);

  const duplicateNameRows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.userId, userId),
        eq(schema.projects.normalizedName, normalizedName)
      )
    )
    .limit(1);
  if (duplicateNameRows[0]) {
    throw errors.conflict('Project name must be unique per user');
  }

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

  const now = new Date().toISOString();
  const projectId = ulid();

  await db.insert(schema.projects).values({
    id: projectId,
    userId,
    name,
    normalizedName,
    description,
    installationId: installation.id,
    repository,
    defaultBranch,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });

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

projectsRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);

  const requestedLimit = parsePositiveInt(c.req.query('limit'), limits.taskListDefaultPageSize);
  const limit = Math.min(requestedLimit, limits.taskListMaxPageSize);
  const cursor = c.req.query('cursor')?.trim();

  const conditions = [eq(schema.projects.userId, userId)];
  if (cursor) {
    conditions.push(lt(schema.projects.id, cursor));
  }

  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(...conditions))
    .orderBy(desc(schema.projects.id))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const projects = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor = hasNextPage ? (projects[projects.length - 1]?.id ?? null) : null;

  const response: ListProjectsResponse = {
    projects: projects.map(toProjectResponse),
    nextCursor,
  };

  return c.json(response);
});

projectsRoutes.get('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const project = await requireOwnedProject(db, projectId, userId);

  const taskCountsRows = await db
    .select({ status: schema.tasks.status, count: count() })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, project.id))
    .groupBy(schema.tasks.status);

  const taskCountsByStatus: Partial<Record<TaskStatus, number>> = {};
  for (const row of taskCountsRows) {
    taskCountsByStatus[row.status as TaskStatus] = Number(row.count);
  }

  const linkedWorkspacesRow = await db
    .select({ count: sql<number>`count(distinct ${schema.tasks.workspaceId})` })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.projectId, project.id), isNotNull(schema.tasks.workspaceId)))
    .limit(1);

  const response: ProjectDetailResponse = {
    ...toProjectResponse(project),
    summary: {
      taskCountsByStatus,
      linkedWorkspaces: linkedWorkspacesRow[0]?.count ?? 0,
    },
  };

  return c.json(response);
});

projectsRoutes.get('/:id/runtime-config', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const project = await requireOwnedProject(db, projectId, userId);
  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

projectsRoutes.post('/:id/runtime/env-vars', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpsertProjectRuntimeEnvVarRequest>();
  const limits = getRuntimeLimits(c.env);

  const project = await requireOwnedProject(db, projectId, userId);
  const envKey = body.key?.trim();
  if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
    throw errors.badRequest('key must match [A-Za-z_][A-Za-z0-9_]*');
  }

  if (typeof body.value !== 'string') {
    throw errors.badRequest('value is required');
  }
  if (byteLength(body.value) > limits.maxProjectRuntimeEnvValueBytes) {
    throw errors.badRequest(
      `value exceeds max size of ${limits.maxProjectRuntimeEnvValueBytes} bytes`
    );
  }

  const isSecret = Boolean(body.isSecret);
  const existingRows = await db
    .select({ id: schema.projectRuntimeEnvVars.id })
    .from(schema.projectRuntimeEnvVars)
    .where(
      and(
        eq(schema.projectRuntimeEnvVars.projectId, project.id),
        eq(schema.projectRuntimeEnvVars.userId, userId),
        eq(schema.projectRuntimeEnvVars.envKey, envKey)
      )
    )
    .limit(1);

  if (!existingRows[0]) {
    const countRows = await db
      .select({ count: count() })
      .from(schema.projectRuntimeEnvVars)
      .where(
        and(
          eq(schema.projectRuntimeEnvVars.projectId, project.id),
          eq(schema.projectRuntimeEnvVars.userId, userId)
        )
      );

    if ((countRows[0]?.count ?? 0) >= limits.maxProjectRuntimeEnvVarsPerProject) {
      throw errors.badRequest(
        `Maximum ${limits.maxProjectRuntimeEnvVarsPerProject} runtime env vars allowed per project`
      );
    }
  }

  const stored = isSecret
    ? await encrypt(body.value, c.env.ENCRYPTION_KEY)
    : { ciphertext: body.value, iv: null };

  const now = new Date().toISOString();
  if (existingRows[0]) {
    await db
      .update(schema.projectRuntimeEnvVars)
      .set({
        storedValue: stored.ciphertext,
        valueIv: stored.iv,
        isSecret,
        updatedAt: now,
      })
      .where(eq(schema.projectRuntimeEnvVars.id, existingRows[0].id));
  } else {
    await db.insert(schema.projectRuntimeEnvVars).values({
      id: ulid(),
      projectId: project.id,
      userId,
      envKey,
      storedValue: stored.ciphertext,
      valueIv: stored.iv,
      isSecret,
      createdAt: now,
      updatedAt: now,
    });
  }

  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

projectsRoutes.delete('/:id/runtime/env-vars/:envKey', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const envKey = c.req.param('envKey')?.trim();
  const db = drizzle(c.env.DATABASE, { schema });

  if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
    throw errors.badRequest('envKey must match [A-Za-z_][A-Za-z0-9_]*');
  }

  const project = await requireOwnedProject(db, projectId, userId);

  await db
    .delete(schema.projectRuntimeEnvVars)
    .where(
      and(
        eq(schema.projectRuntimeEnvVars.projectId, project.id),
        eq(schema.projectRuntimeEnvVars.userId, userId),
        eq(schema.projectRuntimeEnvVars.envKey, envKey)
      )
    );

  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

projectsRoutes.post('/:id/runtime/files', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpsertProjectRuntimeFileRequest>();
  const limits = getRuntimeLimits(c.env);
  const project = await requireOwnedProject(db, projectId, userId);

  const path = normalizeProjectFilePath(body.path ?? '');
  if (path.length > limits.maxProjectRuntimeFilePathLength) {
    throw errors.badRequest(
      `path exceeds max length of ${limits.maxProjectRuntimeFilePathLength} characters`
    );
  }

  if (typeof body.content !== 'string') {
    throw errors.badRequest('content is required');
  }
  if (byteLength(body.content) > limits.maxProjectRuntimeFileContentBytes) {
    throw errors.badRequest(
      `content exceeds max size of ${limits.maxProjectRuntimeFileContentBytes} bytes`
    );
  }

  const isSecret = Boolean(body.isSecret);
  const existingRows = await db
    .select({ id: schema.projectRuntimeFiles.id })
    .from(schema.projectRuntimeFiles)
    .where(
      and(
        eq(schema.projectRuntimeFiles.projectId, project.id),
        eq(schema.projectRuntimeFiles.userId, userId),
        eq(schema.projectRuntimeFiles.filePath, path)
      )
    )
    .limit(1);

  if (!existingRows[0]) {
    const countRows = await db
      .select({ count: count() })
      .from(schema.projectRuntimeFiles)
      .where(
        and(
          eq(schema.projectRuntimeFiles.projectId, project.id),
          eq(schema.projectRuntimeFiles.userId, userId)
        )
      );

    if ((countRows[0]?.count ?? 0) >= limits.maxProjectRuntimeFilesPerProject) {
      throw errors.badRequest(
        `Maximum ${limits.maxProjectRuntimeFilesPerProject} runtime files allowed per project`
      );
    }
  }

  const stored = isSecret
    ? await encrypt(body.content, c.env.ENCRYPTION_KEY)
    : { ciphertext: body.content, iv: null };
  const now = new Date().toISOString();

  if (existingRows[0]) {
    await db
      .update(schema.projectRuntimeFiles)
      .set({
        storedContent: stored.ciphertext,
        contentIv: stored.iv,
        isSecret,
        updatedAt: now,
      })
      .where(eq(schema.projectRuntimeFiles.id, existingRows[0].id));
  } else {
    await db.insert(schema.projectRuntimeFiles).values({
      id: ulid(),
      projectId: project.id,
      userId,
      filePath: path,
      storedContent: stored.ciphertext,
      contentIv: stored.iv,
      isSecret,
      createdAt: now,
      updatedAt: now,
    });
  }

  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

projectsRoutes.delete('/:id/runtime/files', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const rawPath = c.req.query('path');
  const db = drizzle(c.env.DATABASE, { schema });
  const project = await requireOwnedProject(db, projectId, userId);

  if (!rawPath) {
    throw errors.badRequest('path query parameter is required');
  }
  const path = normalizeProjectFilePath(rawPath);

  await db
    .delete(schema.projectRuntimeFiles)
    .where(
      and(
        eq(schema.projectRuntimeFiles.projectId, project.id),
        eq(schema.projectRuntimeFiles.userId, userId),
        eq(schema.projectRuntimeFiles.filePath, path)
      )
    );

  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

projectsRoutes.patch('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpdateProjectRequest>();

  const existing = await requireOwnedProject(db, projectId, userId);

  if (
    body.name === undefined &&
    body.description === undefined &&
    body.defaultBranch === undefined
  ) {
    throw errors.badRequest('At least one field is required');
  }

  const nextName = body.name === undefined ? existing.name : body.name.trim();
  const nextDefaultBranch =
    body.defaultBranch === undefined ? existing.defaultBranch : body.defaultBranch.trim();

  if (!nextName) {
    throw errors.badRequest('name cannot be empty');
  }
  if (!nextDefaultBranch) {
    throw errors.badRequest('defaultBranch cannot be empty');
  }

  await assertRepositoryAccess(
    (await requireOwnedInstallation(db, existing.installationId, userId)).installationId,
    existing.repository,
    c.env
  );

  const normalizedName = normalizeProjectName(nextName);

  const duplicateRows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.userId, userId),
        eq(schema.projects.normalizedName, normalizedName),
        ne(schema.projects.id, projectId)
      )
    )
    .limit(1);

  if (duplicateRows[0]) {
    throw errors.conflict('Project name must be unique per user');
  }

  await db
    .update(schema.projects)
    .set({
      name: nextName,
      normalizedName,
      description: body.description === undefined ? existing.description : body.description?.trim() || null,
      defaultBranch: nextDefaultBranch,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)));

  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
    .limit(1);

  const updated = rows[0];
  if (!updated) {
    throw errors.notFound('Project');
  }

  return c.json(toProjectResponse(updated));
});

projectsRoutes.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  await db
    .delete(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)));

  return c.json({ success: true });
});

export { projectsRoutes };
