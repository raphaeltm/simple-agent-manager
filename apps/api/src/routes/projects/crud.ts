import type {
  ListProjectsResponse,
  ProjectDetailResponse,
  TaskStatus,
} from '@simple-agent-manager/shared';
import { and, count, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toProjectResponse, toProjectSummaryResponse } from '../../lib/mappers';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { ulid } from '../../lib/ulid';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectAccess, requireProjectCapability } from '../../middleware/project-auth';
import {
  jsonValidator,
  UpsertProjectRuntimeEnvVarSchema,
  UpsertProjectRuntimeFileSchema,
} from '../../schemas';
import { encrypt } from '../../services/encryption';
import {
  buildProjectLibraryDeleteStatements,
  buildProjectLibraryR2Prefix,
  deleteProjectLibraryObjects,
  getProjectDeleteCleanupBatchSize,
} from '../../services/file-library';
import { getRuntimeLimits } from '../../services/limits';
import * as projectDataService from '../../services/project-data';
import { getProjectMultiplayerState } from '../../services/project-multiplayer';
import {
  buildProjectRuntimeConfigResponse,
  byteLength,
  normalizeProjectFilePath,
  PROJECT_ENV_KEY_PATTERN,
} from './_helpers';
import { registerProjectCreateRoute } from './project-create';
import { registerProjectUpdateRoute } from './project-update';

const crudRoutes = new Hono<{ Bindings: Env }>();

async function cleanupArtifactsRepoOnProjectDelete(
  env: Env,
  project: schema.Project
): Promise<void> {
  if (project.repoProvider !== 'artifacts' || !project.artifactsRepoId) {
    return;
  }

  const orphanDetails = {
    projectId: project.id,
    repoName: project.artifactsRepoId,
    userId: project.userId,
    action: 'orphaned_artifacts_repo_on_delete',
  };

  if (!env.ARTIFACTS || typeof env.ARTIFACTS.delete !== 'function') {
    log.warn('project_delete.artifacts_delete_unavailable', orphanDetails);
    return;
  }

  try {
    const deleted = await env.ARTIFACTS.delete(project.artifactsRepoId);
    if (!deleted) {
      log.warn('project_delete.artifacts_delete_returned_false', orphanDetails);
    }
  } catch (err) {
    log.warn('project_delete.artifacts_delete_failed', {
      ...orphanDetails,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

registerProjectCreateRoute(crudRoutes);

crudRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const limits = getRuntimeLimits(c.env);

  const requestedLimit = parsePositiveInt(c.req.query('limit'), limits.taskListDefaultPageSize);
  const limit = Math.min(requestedLimit, limits.taskListMaxPageSize);
  const cursor = c.req.query('cursor')?.trim();
  const statusFilter = c.req.query('status')?.trim();
  const sortField = c.req.query('sort')?.trim() || 'last_activity';

  const conditions = [
    sql`exists (
      select 1
      from ${schema.projectMembers}
      where ${schema.projectMembers.projectId} = ${schema.projects.id}
        and ${schema.projectMembers.userId} = ${userId}
        and ${schema.projectMembers.status} = 'active'
    )`,
  ];
  if (cursor) {
    conditions.push(lt(schema.projects.id, cursor));
  }
  if (statusFilter && (statusFilter === 'active' || statusFilter === 'detached')) {
    conditions.push(eq(schema.projects.status, statusFilter));
  }

  // Choose sort order
  const orderBy =
    sortField === 'name'
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
          sql`${schema.workspaces.projectId} IN (${sql.join(
            projectIds.map((id) => sql`${id}`),
            sql`, `
          )})`,
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
    projects: projects.map((p) => toProjectSummaryResponse(p, workspaceCountMap.get(p.id) ?? 0)),
    nextCursor,
  };

  return c.json(response);
});

crudRoutes.get('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const project = await requireProjectAccess(db, projectId, userId);

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
      and(eq(schema.workspaces.projectId, project.id), eq(schema.workspaces.status, 'running'))
    );

  const multiplayerState = await getProjectMultiplayerState(db, project.id);

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
    log.error('project.do_fetch_failed', {
      projectId: project.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const response: ProjectDetailResponse = {
    ...toProjectResponse(project),
    multiplayerActive: multiplayerState.multiplayerActive,
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

  const project = await requireProjectCapability(db, projectId, userId, 'secret:read');
  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

crudRoutes.post(
  '/:id/runtime/env-vars',
  jsonValidator(UpsertProjectRuntimeEnvVarSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    const body = c.req.valid('json');
    const limits = getRuntimeLimits(c.env);

    const project = await requireProjectCapability(db, projectId, userId, 'secret:write');
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
          eq(schema.projectRuntimeEnvVars.envKey, envKey)
        )
      )
      .limit(1);

    if (!existingRows[0]) {
      const countRows = await db
        .select({ count: count() })
        .from(schema.projectRuntimeEnvVars)
        .where(and(eq(schema.projectRuntimeEnvVars.projectId, project.id)));

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
  }
);

crudRoutes.delete('/:id/runtime/env-vars/:envKey', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const envKey = c.req.param('envKey')?.trim();
  const db = drizzle(c.env.DATABASE, { schema });

  if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
    throw errors.badRequest('envKey must match [A-Za-z_][A-Za-z0-9_]*');
  }

  const project = await requireProjectCapability(db, projectId, userId, 'secret:write');

  await db
    .delete(schema.projectRuntimeEnvVars)
    .where(
      and(
        eq(schema.projectRuntimeEnvVars.projectId, project.id),
        eq(schema.projectRuntimeEnvVars.envKey, envKey)
      )
    );

  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

crudRoutes.post('/:id/runtime/files', jsonValidator(UpsertProjectRuntimeFileSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);
  const project = await requireProjectCapability(db, projectId, userId, 'secret:write');

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
        eq(schema.projectRuntimeFiles.filePath, path)
      )
    )
    .limit(1);

  if (!existingRows[0]) {
    const countRows = await db
      .select({ count: count() })
      .from(schema.projectRuntimeFiles)
      .where(and(eq(schema.projectRuntimeFiles.projectId, project.id)));

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
  const project = await requireProjectCapability(db, projectId, userId, 'secret:write');

  if (!rawPath) {
    throw errors.badRequest('path query parameter is required');
  }
  const path = normalizeProjectFilePath(rawPath);

  await db
    .delete(schema.projectRuntimeFiles)
    .where(
      and(
        eq(schema.projectRuntimeFiles.projectId, project.id),
        eq(schema.projectRuntimeFiles.filePath, path)
      )
    );

  const response = await buildProjectRuntimeConfigResponse(db, project);
  return c.json(response);
});

registerProjectUpdateRoute(crudRoutes);

crudRoutes.delete('/:id', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const project = await requireProjectCapability(db, projectId, userId, 'project:delete');

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
        db.delete(schema.taskStatusEvents).where(inArray(schema.taskStatusEvents.taskId, chunk))
      );
      statements.push(
        db.delete(schema.taskDependencies).where(inArray(schema.taskDependencies.taskId, chunk))
      );
      // Also clean up dependencies referencing these tasks from other projects
      statements.push(
        db
          .delete(schema.taskDependencies)
          .where(inArray(schema.taskDependencies.dependsOnTaskId, chunk))
      );
    }
  }

  // Direct child records
  statements.push(db.delete(schema.tasks).where(eq(schema.tasks.projectId, projectId)));
  statements.push(
    db
      .delete(schema.projectRuntimeEnvVars)
      .where(eq(schema.projectRuntimeEnvVars.projectId, projectId))
  );
  statements.push(
    db.delete(schema.projectRuntimeFiles).where(eq(schema.projectRuntimeFiles.projectId, projectId))
  );
  statements.push(
    db.delete(schema.agentProfiles).where(eq(schema.agentProfiles.projectId, projectId))
  );
  statements.push(
    db
      .delete(schema.projectGithubRepositories)
      .where(eq(schema.projectGithubRepositories.projectId, projectId))
  );
  statements.push(
    db
      .delete(schema.projectGitlabRepositories)
      .where(eq(schema.projectGitlabRepositories.projectId, projectId))
  );
  statements.push(...buildProjectLibraryDeleteStatements(db, projectId));

  // Detach workspaces (ALTER TABLE FK ON DELETE SET NULL is not enforced)
  statements.push(
    db
      .update(schema.workspaces)
      .set({ projectId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.workspaces.projectId, projectId))
  );

  // Delete the project itself
  statements.push(
    db
      .delete(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
  );

  // 3. Execute all mutations atomically via D1 batch.
  await db.batch(statements as [(typeof statements)[0]]);

  // R2 deletion can require paginated storage I/O, so keep it outside the D1 batch
  // and off the request's critical path. The helper derives and validates the exact
  // library/{projectId}/ prefix; a foreign key from R2 aborts the page fail-closed.
  const libraryPrefix = buildProjectLibraryR2Prefix(projectId);
  const libraryCleanup = deleteProjectLibraryObjects(
    c.env.R2,
    projectId,
    getProjectDeleteCleanupBatchSize(c.env)
  )
    .then((stats) => {
      log.info('project_delete.library_cleanup_completed', {
        projectId,
        prefix: stats.prefix,
        listedObjects: stats.listedObjects,
        deletedObjects: stats.deletedObjects,
      });
    })
    .catch((err) => {
      log.warn('project_delete.library_cleanup_failed', {
        projectId,
        prefix: libraryPrefix,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  try {
    c.executionCtx.waitUntil(libraryCleanup);
  } catch {
    // Hono unit tests do not always provide an execution context. Production Workers
    // always take the waitUntil path; awaiting here keeps the fallback deterministic.
    await libraryCleanup;
  }

  // Artifacts repo count limits are enforced from project rows. If this
  // best-effort external cleanup cannot run, the deleted project no longer
  // counts against ARTIFACTS_MAX_REPOS_PER_USER and the orphan is logged for
  // manual reconciliation.
  await cleanupArtifactsRepoOnProjectDelete(c.env, project);

  return c.json({ success: true });
});

export { crudRoutes };
