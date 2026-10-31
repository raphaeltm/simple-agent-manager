import type { ListProjectsResponse } from '@simple-agent-manager/shared';
import { and, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toProjectSummaryResponse } from '../../lib/mappers';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getUserId } from '../../middleware/auth';
import { requireProjectCapability } from '../../middleware/project-auth';
import {
  buildProjectLibraryDeleteStatements,
  buildProjectLibraryR2Prefix,
  deleteProjectLibraryObjects,
  getProjectDeleteCleanupBatchSize,
} from '../../services/file-library';
import { getRuntimeLimits } from '../../services/limits';
import { deleteWorkspaceResourceHistoryObjectsForProject } from '../../services/workspace-resource-history';
import { registerProjectCreateRoute } from './project-create';
import { registerProjectDetailRoute } from './project-detail';
import { registerProjectUpdateRoute } from './project-update';
import { registerProjectRuntimeConfigRoutes } from './runtime-config';

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

registerProjectDetailRoute(crudRoutes);
registerProjectRuntimeConfigRoutes(crudRoutes);

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

  const resourceHistoryCleanup = deleteWorkspaceResourceHistoryObjectsForProject(c.env, projectId)
    .then((stats) => {
      log.info('project_delete.resource_history_cleanup_completed', {
        projectId,
        prefix: stats.prefix,
        listedObjects: stats.listedObjects,
        deletedObjects: stats.deletedObjects,
        truncated: stats.truncated,
      });
    })
    .catch((err) => {
      log.warn('project_delete.resource_history_cleanup_failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  const r2Cleanup = Promise.all([libraryCleanup, resourceHistoryCleanup]);

  try {
    c.executionCtx.waitUntil(r2Cleanup);
  } catch {
    // Hono unit tests do not always provide an execution context. Production Workers
    // always take the waitUntil path; awaiting here keeps the fallback deterministic.
    await r2Cleanup;
  }

  // Artifacts repo count limits are enforced from project rows. If this
  // best-effort external cleanup cannot run, the deleted project no longer
  // counts against ARTIFACTS_MAX_REPOS_PER_USER and the orphan is logged for
  // manual reconciliation.
  await cleanupArtifactsRepoOnProjectDelete(c.env, project);

  return c.json({ success: true });
});

export { crudRoutes };
