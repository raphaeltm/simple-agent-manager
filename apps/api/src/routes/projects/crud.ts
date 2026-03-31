import { Hono } from 'hono';
import { and, count, desc, eq, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type {
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  ProjectDetailResponse,
  TaskStatus,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
  UpdateProjectRequest,
} from '@simple-agent-manager/shared';
import {
  isValidAgentType,
  VALID_WORKSPACE_PROFILES,
  CREDENTIAL_PROVIDERS,
  MIN_WORKSPACE_IDLE_TIMEOUT_MS,
  MAX_WORKSPACE_IDLE_TIMEOUT_MS,
  MIN_NODE_IDLE_TIMEOUT_MS,
  MAX_NODE_IDLE_TIMEOUT_MS,
  isValidLocationForProvider,
  SCALING_PARAMS,
} from '@simple-agent-manager/shared';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { getRuntimeLimits } from '../../services/limits';
import { encrypt } from '../../services/encryption';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import * as projectDataService from '../../services/project-data';
import { toProjectResponse, toProjectSummaryResponse } from '../../lib/mappers';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  normalizeProjectName,
  normalizeRepository,
  isValidRepositoryFormat,
  byteLength,
  PROJECT_ENV_KEY_PATTERN,
  normalizeProjectFilePath,
  buildProjectRuntimeConfigResponse,
  requireOwnedInstallation,
  assertRepositoryAccess,
} from './_helpers';
import { log } from '../../lib/logger';

const crudRoutes = new Hono<{ Bindings: Env }>();

crudRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);
  const body = await c.req.json<CreateProjectRequest>();

  const name = body.name?.trim();
  const installationId = body.installationId?.trim();
  const repository = normalizeRepository(body.repository ?? '');
  const defaultBranch = body.defaultBranch?.trim();
  const description = body.description?.trim() || null;
  const githubRepoId = typeof body.githubRepoId === 'number' ? body.githubRepoId : null;
  const githubRepoNodeId = body.githubRepoNodeId?.trim() || null;

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

  // Enforce unique (userId, githubRepoId) when provided
  if (githubRepoId !== null) {
    const duplicateRepoIdRows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.userId, userId),
          eq(schema.projects.githubRepoId, githubRepoId)
        )
      )
      .limit(1);
    if (duplicateRepoIdRows[0]) {
      throw errors.conflict('A project with this GitHub repository ID already exists');
    }
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
    githubRepoId,
    githubRepoNodeId,
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

crudRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);

  const requestedLimit = parsePositiveInt(c.req.query('limit'), limits.taskListDefaultPageSize);
  const limit = Math.min(requestedLimit, limits.taskListMaxPageSize);
  const cursor = c.req.query('cursor')?.trim();
  const statusFilter = c.req.query('status')?.trim();
  const sortField = c.req.query('sort')?.trim() || 'last_activity';

  const conditions = [eq(schema.projects.userId, userId)];
  if (cursor) {
    conditions.push(lt(schema.projects.id, cursor));
  }
  if (statusFilter && (statusFilter === 'active' || statusFilter === 'detached')) {
    conditions.push(eq(schema.projects.status, statusFilter));
  }

  // Choose sort order
  const orderBy = sortField === 'name'
    ? desc(schema.projects.name)
    : sortField === 'created_at'
      ? desc(schema.projects.createdAt)
      : desc(schema.projects.lastActivityAt);

  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(...conditions))
    .orderBy(orderBy, desc(schema.projects.id))
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const projects = hasNextPage ? rows.slice(0, limit) : rows;
  const nextCursor = hasNextPage ? (projects[projects.length - 1]?.id ?? null) : null;

  // Batch query for active workspace counts per project
  const projectIds = projects.map((p) => p.id);
  const workspaceCountMap = new Map<string, number>();
  if (projectIds.length > 0) {
    const wsCounts = await db
      .select({
        projectId: schema.workspaces.projectId,
        count: count(),
      })
      .from(schema.workspaces)
      .where(
        and(
          sql`${schema.workspaces.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`,
          eq(schema.workspaces.status, 'running')
        )
      )
      .groupBy(schema.workspaces.projectId);

    for (const row of wsCounts) {
      if (row.projectId) {
        workspaceCountMap.set(row.projectId, row.count);
      }
    }
  }

  const response: ListProjectsResponse = {
    projects: projects.map((p) =>
      toProjectSummaryResponse(p, workspaceCountMap.get(p.id) ?? 0) as unknown as Project
    ),
    nextCursor,
  };

  return c.json(response);
});

crudRoutes.get('/:id', async (c) => {
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

  const activeWorkspaceCountRow = await db
    .select({ count: count() })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.projectId, project.id),
        eq(schema.workspaces.status, 'running')
      )
    );

  // Fetch recent sessions and activity from the project's DO (best-effort)
  let recentSessions: Record<string, unknown>[] = [];
  let recentActivity: Record<string, unknown>[] = [];
  try {
    const [sessionsResult, activityResult] = await Promise.all([
      projectDataService.listSessions(c.env, project.id, null, 5, 0),
      projectDataService.listActivityEvents(c.env, project.id, null, 10, null),
    ]);
    recentSessions = sessionsResult.sessions;
    recentActivity = activityResult.events;
  } catch (err) {
    // DO may not exist yet for projects created before this feature
    log.error('project.do_fetch_failed', { projectId: project.id, error: err instanceof Error ? err.message : String(err) });
  }

  const response: ProjectDetailResponse = {
    ...toProjectResponse(project),
    summary: {
      taskCountsByStatus,
      linkedWorkspaces: linkedWorkspacesRow[0]?.count ?? 0,
      activeWorkspaceCount: activeWorkspaceCountRow[0]?.count ?? 0,
      activeSessionCount: project.activeSessionCount ?? 0,
      lastActivityAt: project.lastActivityAt ?? null,
    },
    recentSessions,
    recentActivity,
  } as ProjectDetailResponse & { recentSessions: unknown[]; recentActivity: unknown[] };

  return c.json(response);
});

crudRoutes.get('/:id/runtime-config', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const project = await requireOwnedProject(db, projectId, userId);
  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

crudRoutes.post('/:id/runtime/env-vars', async (c) => {
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
    ? await encrypt(body.value, getCredentialEncryptionKey(c.env))
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

crudRoutes.delete('/:id/runtime/env-vars/:envKey', async (c) => {
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

crudRoutes.post('/:id/runtime/files', async (c) => {
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
    ? await encrypt(body.content, getCredentialEncryptionKey(c.env))
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

crudRoutes.delete('/:id/runtime/files', async (c) => {
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

crudRoutes.patch('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<UpdateProjectRequest>();

  const existing = await requireOwnedProject(db, projectId, userId);

  const allFieldKeys: (keyof UpdateProjectRequest)[] = [
    'name', 'description', 'defaultBranch', 'defaultVmSize', 'defaultAgentType',
    'defaultWorkspaceProfile', 'defaultProvider', 'defaultLocation',
    'workspaceIdleTimeoutMs', 'nodeIdleTimeoutMs',
    'taskExecutionTimeoutMs', 'maxConcurrentTasks', 'maxDispatchDepth', 'maxSubTasksPerTask',
    'warmNodeTimeoutMs', 'maxWorkspacesPerNode', 'nodeCpuThresholdPercent', 'nodeMemoryThresholdPercent',
  ];
  if (allFieldKeys.every((k) => body[k] === undefined)) {
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

  const validVmSizes = ['small', 'medium', 'large'];
  if (body.defaultVmSize !== undefined && body.defaultVmSize !== null && !validVmSizes.includes(body.defaultVmSize)) {
    throw errors.badRequest('defaultVmSize must be small, medium, or large');
  }

  if (body.defaultAgentType !== undefined && body.defaultAgentType !== null && !isValidAgentType(body.defaultAgentType)) {
    throw errors.badRequest('defaultAgentType must be a valid agent type');
  }

  if (body.defaultWorkspaceProfile !== undefined && body.defaultWorkspaceProfile !== null && !VALID_WORKSPACE_PROFILES.includes(body.defaultWorkspaceProfile)) {
    throw errors.badRequest('defaultWorkspaceProfile must be full or lightweight');
  }

  if (body.defaultProvider !== undefined && body.defaultProvider !== null && !CREDENTIAL_PROVIDERS.includes(body.defaultProvider)) {
    throw errors.badRequest(`defaultProvider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`);
  }

  // Determine the effective provider for location validation
  const effectiveProvider = body.defaultProvider === undefined
    ? existing.defaultProvider
    : (body.defaultProvider ?? null);

  // If defaultProvider changed, clear defaultLocation unless explicitly set in this request
  if (body.defaultProvider !== undefined && body.defaultProvider !== existing.defaultProvider && body.defaultLocation === undefined) {
    body.defaultLocation = null;
  }

  // Validate defaultLocation against the effective provider
  if (body.defaultLocation !== undefined && body.defaultLocation !== null) {
    if (!effectiveProvider) {
      throw errors.badRequest('Cannot set defaultLocation without a defaultProvider');
    }
    if (!isValidLocationForProvider(effectiveProvider, body.defaultLocation)) {
      throw errors.badRequest(`defaultLocation '${body.defaultLocation}' is not valid for provider '${effectiveProvider}'`);
    }
  }

  // Validate per-project scaling parameters
  for (const param of SCALING_PARAMS) {
    const value = body[param.key as keyof UpdateProjectRequest] as number | null | undefined;
    if (value !== undefined && value !== null) {
      if (!Number.isFinite(value) || value < param.min || value > param.max) {
        throw errors.badRequest(`${param.key} must be between ${param.min} and ${param.max}`);
      }
    }
  }

  if (body.workspaceIdleTimeoutMs !== undefined && body.workspaceIdleTimeoutMs !== null) {
    if (!Number.isFinite(body.workspaceIdleTimeoutMs) || body.workspaceIdleTimeoutMs < MIN_WORKSPACE_IDLE_TIMEOUT_MS || body.workspaceIdleTimeoutMs > MAX_WORKSPACE_IDLE_TIMEOUT_MS) {
      throw errors.badRequest(`workspaceIdleTimeoutMs must be between ${MIN_WORKSPACE_IDLE_TIMEOUT_MS} and ${MAX_WORKSPACE_IDLE_TIMEOUT_MS}`);
    }
  }

  if (body.nodeIdleTimeoutMs !== undefined && body.nodeIdleTimeoutMs !== null) {
    if (!Number.isFinite(body.nodeIdleTimeoutMs) || body.nodeIdleTimeoutMs < MIN_NODE_IDLE_TIMEOUT_MS || body.nodeIdleTimeoutMs > MAX_NODE_IDLE_TIMEOUT_MS) {
      throw errors.badRequest(`nodeIdleTimeoutMs must be between ${MIN_NODE_IDLE_TIMEOUT_MS} and ${MAX_NODE_IDLE_TIMEOUT_MS}`);
    }
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
      defaultVmSize: body.defaultVmSize === undefined ? existing.defaultVmSize : (body.defaultVmSize ?? null),
      defaultAgentType: body.defaultAgentType === undefined ? existing.defaultAgentType : (body.defaultAgentType ?? null),
      defaultWorkspaceProfile: body.defaultWorkspaceProfile === undefined ? existing.defaultWorkspaceProfile : (body.defaultWorkspaceProfile ?? null),
      defaultProvider: body.defaultProvider === undefined ? existing.defaultProvider : (body.defaultProvider ?? null),
      defaultLocation: body.defaultLocation === undefined ? existing.defaultLocation : (body.defaultLocation ?? null),
      workspaceIdleTimeoutMs: body.workspaceIdleTimeoutMs === undefined ? existing.workspaceIdleTimeoutMs : (body.workspaceIdleTimeoutMs ?? null),
      nodeIdleTimeoutMs: body.nodeIdleTimeoutMs === undefined ? existing.nodeIdleTimeoutMs : (body.nodeIdleTimeoutMs ?? null),
      taskExecutionTimeoutMs: body.taskExecutionTimeoutMs === undefined ? existing.taskExecutionTimeoutMs : (body.taskExecutionTimeoutMs ?? null),
      maxConcurrentTasks: body.maxConcurrentTasks === undefined ? existing.maxConcurrentTasks : (body.maxConcurrentTasks ?? null),
      maxDispatchDepth: body.maxDispatchDepth === undefined ? existing.maxDispatchDepth : (body.maxDispatchDepth ?? null),
      maxSubTasksPerTask: body.maxSubTasksPerTask === undefined ? existing.maxSubTasksPerTask : (body.maxSubTasksPerTask ?? null),
      warmNodeTimeoutMs: body.warmNodeTimeoutMs === undefined ? existing.warmNodeTimeoutMs : (body.warmNodeTimeoutMs ?? null),
      maxWorkspacesPerNode: body.maxWorkspacesPerNode === undefined ? existing.maxWorkspacesPerNode : (body.maxWorkspacesPerNode ?? null),
      nodeCpuThresholdPercent: body.nodeCpuThresholdPercent === undefined ? existing.nodeCpuThresholdPercent : (body.nodeCpuThresholdPercent ?? null),
      nodeMemoryThresholdPercent: body.nodeMemoryThresholdPercent === undefined ? existing.nodeMemoryThresholdPercent : (body.nodeMemoryThresholdPercent ?? null),
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

crudRoutes.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  // Explicitly delete child records instead of relying on D1 CASCADE.
  // SQLite ignores REFERENCES constraints added via ALTER TABLE, so
  // workspaces.project_id ON DELETE SET NULL never fires. Complex CASCADE
  // chains (projects → tasks → task_dependencies/task_status_events) can
  // also fail silently in D1.

  // 1. Find all task IDs for this project (needed for grandchild cleanup).
  //    Task count is bounded by getRuntimeLimits().maxTasksPerProject.
  const projectTasks = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId));
  const taskIds = projectTasks.map((t) => t.id);

  // 2. Build all mutation statements for a single atomic db.batch() call.
  //    D1 limits bound parameters to 100 per statement, so chunk inArray.
  const D1_PARAM_LIMIT = 100;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statements: any[] = [];

  // Grandchild cleanup: task_status_events and task_dependencies
  if (taskIds.length > 0) {
    for (let i = 0; i < taskIds.length; i += D1_PARAM_LIMIT) {
      const chunk = taskIds.slice(i, i + D1_PARAM_LIMIT);
      statements.push(
        db.delete(schema.taskStatusEvents).where(inArray(schema.taskStatusEvents.taskId, chunk)),
      );
      statements.push(
        db.delete(schema.taskDependencies).where(inArray(schema.taskDependencies.taskId, chunk)),
      );
      // Also clean up dependencies referencing these tasks from other projects
      statements.push(
        db
          .delete(schema.taskDependencies)
          .where(inArray(schema.taskDependencies.dependsOnTaskId, chunk)),
      );
    }
  }

  // Direct child records
  statements.push(db.delete(schema.tasks).where(eq(schema.tasks.projectId, projectId)));
  statements.push(
    db
      .delete(schema.projectRuntimeEnvVars)
      .where(eq(schema.projectRuntimeEnvVars.projectId, projectId)),
  );
  statements.push(
    db
      .delete(schema.projectRuntimeFiles)
      .where(eq(schema.projectRuntimeFiles.projectId, projectId)),
  );
  statements.push(
    db.delete(schema.agentProfiles).where(eq(schema.agentProfiles.projectId, projectId)),
  );

  // Detach workspaces (ALTER TABLE FK ON DELETE SET NULL is not enforced)
  statements.push(
    db
      .update(schema.workspaces)
      .set({ projectId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.projectId, projectId)),
  );

  // Delete the project itself
  statements.push(
    db
      .delete(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId))),
  );

  // 3. Execute all mutations atomically via D1 batch.
  await db.batch(statements as [typeof statements[0]]);

  return c.json({ success: true });
});

export { crudRoutes };
