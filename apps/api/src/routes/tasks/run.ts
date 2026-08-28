/**
 * Task Runs Route
 *
 * Provides the API endpoint for triggering autonomous task execution.
 * POST /api/projects/:projectId/tasks/:taskId/run
 *
 * This endpoint:
 * 1. Validates the task is in 'ready' status and unblocked
 * 2. Queues the task for autonomous execution
 * 3. Returns immediately with 202 Accepted
 * 4. Async: selects/creates node, creates workspace, runs agent, creates PR, cleans up
 */
import type { RunTaskResponse, TaskStatus, VMSize } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { getAuth, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { parseOptionalBody, RunTaskSchema } from '../../schemas';
import {
  CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS,
  capacityPlacementSnapshotSqlValues,
} from '../../services/capacity-placement-snapshot';
import {
  capacityPlacementSnapshotForTaskStart,
  PlacementResolutionError,
  resolveCapacityAwareCredentialLookup,
  resolveCapacityAwareQuotaCredentialSource,
  resolveCapacityPlacementCredentialAttribution,
  resolvePlacementCredentialAttribution,
  resolveTaskStartCapacityPoolSelection,
  resolveTaskStartPlacement,
} from '../../services/placement-resolver';
import * as projectDataService from '../../services/project-data';
import { isTaskBlocked } from '../../services/task-graph';
import { cleanupTaskRun } from '../../services/task-runner';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import { requireRepositoryUserAccess } from '../projects/_helpers';
import { requireProjectTaskById } from './_helpers';

const runRoutes = new Hono<{ Bindings: Env }>();

// Auth applied per-route to avoid Hono middleware leak across sibling subrouters.
// See .claude/rules/06-api-patterns.md and docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md.

/**
 * POST /projects/:projectId/tasks/:taskId/run
 *
 * Trigger autonomous execution of a task.
 * The task must be in 'ready' status and not blocked by dependencies.
 *
 * Request body (all optional):
 *   vmSize: 'small' | 'medium' | 'large' — VM size for workspace (default: medium)
 *   vmLocation: string — VM location (provider-specific, default: nbg1)
 *   nodeId: string — force a specific node (must be running and owned by user)
 *   branch: string — override project default branch
 *
 * Response 202:
 *   taskId, status, workspaceId, nodeId, autoProvisionedNode
 */
runRoutes.post('/:taskId/run', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId) {
    throw errors.badRequest('projectId is required');
  }
  if (!taskId) {
    throw errors.badRequest('taskId is required');
  }

  // Starting or cleaning up a run uses the caller's credentials and compute context.
  const project = await requireProjectCapability(db, projectId, userId, 'task:write');
  const task = await requireProjectTaskById(db, projectId, taskId);

  // Check task status
  if (task.status !== 'ready') {
    throw errors.conflict(
      `Task must be in 'ready' status to run autonomously, currently '${task.status}'`
    );
  }

  // Check for blocked dependencies
  const dependencies = await db
    .select({
      taskId: schema.taskDependencies.taskId,
      dependsOnTaskId: schema.taskDependencies.dependsOnTaskId,
    })
    .from(schema.taskDependencies)
    .where(eq(schema.taskDependencies.taskId, task.id));

  if (dependencies.length > 0) {
    const depTasks = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.projectId, projectId));

    const statusMap: Record<string, TaskStatus> = {};
    for (const t of depTasks) {
      statusMap[t.id] = t.status as TaskStatus;
    }

    if (isTaskBlocked(task.id, dependencies, statusMap)) {
      throw errors.conflict('Task is blocked by unresolved dependencies');
    }
  }

  // Parse request body (optional — empty body means use defaults)
  const body = await parseOptionalBody(c.req.raw, RunTaskSchema, {} as Record<string, never>);

  // vmSize, workspaceProfile validated by schema (picklist)

  // vmLocation validated as string by schema
  // workspaceProfile validated by schema (picklist)

  // Fail-fast user∩app GitHub repo-access gate. Re-verify the user still has
  // access to the bound repository through the app installation BEFORE the task
  // is queued and the Task Runner DO provisions a node / clones the repo. Throws
  // 403 if access was revoked or the repository id drifted.
  await requireRepositoryUserAccess(c, db, project, userId);

  const placement = (() => {
    try {
      return resolveTaskStartPlacement({
        entryPoint: 'task-run',
        taskId: task.id,
        projectId,
        userId,
        project,
        explicit: {
          vmSize: body.vmSize ?? null,
          vmSizeSource: 'task',
          vmLocation: body.vmLocation ?? null,
          workspaceProfile: body.workspaceProfile ?? null,
          devcontainerConfigName: body.devcontainerConfigName,
        },
        credentialProjectPolicy: 'current-project',
        taskModeDefault: 'task',
        resourceRequirements: {},
      });
    } catch (err) {
      if (err instanceof PlacementResolutionError) {
        throw errors.badRequest(err.message);
      }
      throw err;
    }
  })();

  const { resolveCredentialSource } = await import('../../services/provider-credentials');
  const capacityPoolSelection = await resolveTaskStartCapacityPoolSelection(db, placement);
  const credentialLookup = resolveCapacityAwareCredentialLookup(placement, capacityPoolSelection);
  const credResult = await resolveCredentialSource(
    db,
    credentialLookup.userId,
    credentialLookup.provider,
    credentialLookup.projectId
  );
  if (!credResult) {
    throw errors.badRequest(
      'Cloud provider credentials required. Connect your account in Settings.'
    );
  }
  const quotaCredentialSource = resolveCapacityAwareQuotaCredentialSource(
    credResult,
    capacityPoolSelection
  );
  if (quotaCredentialSource === 'platform') {
    const quotaEnforcementEnabled = c.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
    if (quotaEnforcementEnabled) {
      const { checkQuotaForUser } = await import('../../services/compute-quotas');
      const quotaCheck = await checkQuotaForUser(db, userId);
      if (!quotaCheck.allowed) {
        throw errors.forbidden(
          `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
            'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.'
        );
      }
    }
  }

  const {
    effectiveProvider,
    credentialAttributionUserId,
    credentialAttributionProjectId,
    credentialAttributionSource,
  } = capacityPoolSelection?.candidates[0]
    ? resolveCapacityPlacementCredentialAttribution(placement, capacityPoolSelection.candidates[0])
    : resolvePlacementCredentialAttribution(placement, credResult);
  const capacityPlacementSnapshot = capacityPlacementSnapshotForTaskStart(capacityPoolSelection);
  const {
    vmSize,
    vmSizeSource,
    vmLocation,
    workspaceProfile,
    devcontainerConfigName,
    taskMode,
    agentType,
    resolvedReservation,
  } = placement;

  // Explicit run branch means "continue work from this branch". Otherwise,
  // use the task output branch when present so VM-agent completion pushes cannot
  // land on the repository default branch.
  const branch = body.branch?.trim() || task.outputBranch || project.defaultBranch;

  // Look up user's githubId for noreply email fallback
  const [userRow] = await db
    .select({ githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // Transition task to queued with initial execution step (optimistic lock on 'ready')
  const now = new Date().toISOString();
  const transitionResult = await c.env.DATABASE.prepare(
    `UPDATE tasks
     SET status = 'queued',
         execution_step = 'node_selection',
         requested_vm_size = ?,
         requested_vm_size_source = ?,
         resource_requirements_source = ?,
         resolved_reservation_json = ?,
         credential_attribution_user_id = ?,
         credential_attribution_project_id = ?,
         credential_attribution_source = ?,
         ${CAPACITY_PLACEMENT_SNAPSHOT_SQL_ASSIGNMENTS},
         updated_at = ?
     WHERE id = ? AND status = 'ready'`
  )
    .bind(
      vmSize,
      vmSizeSource,
      resolvedReservation.source,
      JSON.stringify(resolvedReservation),
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
      ...capacityPlacementSnapshotSqlValues(capacityPlacementSnapshot),
      now,
      task.id
    )
    .run();

  // If another request already transitioned this task, reject (double-click protection)
  if (!transitionResult.meta.changes || transitionResult.meta.changes === 0) {
    throw errors.conflict('Task has already been queued for execution');
  }
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId: task.id,
    fromStatus: 'ready',
    toStatus: 'queued',
    actorType: 'system',
    actorId: null,
    reason: 'Autonomous task run initiated',
    createdAt: now,
  });

  // TDF-6: Create chat session — REQUIRED (same pattern as task-submit.ts).
  // Tasks from the kanban board "Run" action also need a session.
  // If session creation or DO startup fails, mark the task as failed.
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      c.env,
      projectId,
      null, // workspaceId — linked later by TaskRunner DO when workspace is created
      task.title,
      task.id,
      userId
    );
  } catch (err) {
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: `Session creation failed: ${errorMsg}`,
        updatedAt: failedAt,
      })
      .where(eq(schema.tasks.id, task.id));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId: task.id,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Session creation failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('task_run.session_failed', { taskId: task.id, projectId, error: errorMsg });
    throw err;
  }

  log.info('task_run.session_created', {
    taskId: task.id,
    projectId,
    sessionId,
  });

  // Start TaskRunner DO — alarm-driven orchestration (TDF-2)
  try {
    await startTaskRunnerDO(c.env, {
      taskId: task.id,
      projectId,
      userId,
      vmSize,
      vmLocation,
      branch,
      defaultBranch: project.defaultBranch,
      preferredNodeId: body.nodeId,
      userName: auth.user.name,
      userEmail: auth.user.email,
      githubId: userRow?.githubId ?? null,
      taskTitle: task.title,
      taskDescription: task.description,
      repository: project.repository,
      installationId: project.installationId,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType,
      workspaceProfile,
      devcontainerConfigName,
      cloudProvider: effectiveProvider,
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
      taskMode,
      agentProfileHint: task.agentProfileHint ?? null,
      // Full profile resolution is not supported on the kanban Run path, but the
      // persisted profile hint must still reach TaskRunner so workspace
      // GitHub-token minting can enforce profile SAM platform policy.
      model: null,
      effort: null,
      permissionMode: null,
      projectScaling: {
        taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
        maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
        nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
      },
      resolvedReservation,
      capacityPoolSelection,
      vmSizeSource,
    });
  } catch (err) {
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(schema.tasks)
      .set({
        status: 'failed',
        errorMessage: `Task runner startup failed: ${errorMsg}`,
        updatedAt: failedAt,
      })
      .where(eq(schema.tasks.id, task.id));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId: task.id,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Task runner startup failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('task_run.do_startup_failed', { taskId: task.id, projectId, error: errorMsg });
    // Stop the orphaned session (best-effort — it has no workspace and will never be cleaned up otherwise)
    await projectDataService.stopSession(c.env, projectId, sessionId).catch((e) => {
      log.error('task_run.orphaned_session_stop_failed', {
        projectId,
        sessionId,
        error: String(e),
      });
    });
    throw err;
  }

  const response: RunTaskResponse = {
    taskId: task.id,
    status: 'queued',
    workspaceId: null,
    nodeId: null,
    autoProvisionedNode: false,
  };

  return c.json(response, 202);
});

/**
 * POST /projects/:projectId/tasks/:taskId/run/cleanup
 *
 * Trigger cleanup of a completed/failed task run.
 * Stops the workspace and optionally the auto-provisioned node.
 * This can be called manually or is triggered automatically by the callback mechanism.
 */
runRoutes.post('/:taskId/run/cleanup', requireAuth(), requireApproved(), async (c) => {
  const auth = getAuth(c);
  const userId = auth.user.id;
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  const db = drizzle(c.env.DATABASE, { schema });

  if (!projectId || !taskId) {
    throw errors.badRequest('projectId and taskId are required');
  }

  // Cleanup is project-authorized, while resource mutation remains caller-scoped.
  await requireProjectCapability(db, projectId, userId, 'task:write');
  const task = await requireProjectTaskById(db, projectId, taskId);

  // Only allow cleanup for terminal states
  if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
    throw errors.conflict(
      `Task must be in completed, failed, or cancelled status for cleanup, currently '${task.status}'`
    );
  }

  c.executionCtx.waitUntil(cleanupTaskRun(task.id, c.env, undefined, userId));

  return c.json({ success: true, message: 'Cleanup initiated' });
});

export { runRoutes };
