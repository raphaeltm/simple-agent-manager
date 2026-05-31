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
import type { CredentialProvider,RunTaskResponse, TaskStatus, VMLocation, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { getLocationsForProvider, isValidLocationForProvider, isValidProvider } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { getAuth, requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject, requireOwnedTask } from '../../middleware/project-auth';
import { parseOptionalBody, RunTaskSchema } from '../../schemas';
import * as projectDataService from '../../services/project-data';
import { isTaskBlocked } from '../../services/task-graph';
import { cleanupTaskRun } from '../../services/task-runner';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import { parseResourceRequirementsJson, resolveTaskStartAudit } from '../../services/task-start-audit';

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

  // Validate ownership
  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

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
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          eq(schema.tasks.userId, userId)
        )
      );

    const statusMap: Record<string, TaskStatus> = {};
    for (const t of depTasks) {
      statusMap[t.id] = t.status as TaskStatus;
    }

    if (isTaskBlocked(task.id, dependencies, statusMap)) {
      throw errors.conflict('Task is blocked by unresolved dependencies');
    }
  }

  // Check the user has cloud provider credentials (required for node provisioning)
  const [credential] = await db
    .select({ id: schema.credentials.id })
    .from(schema.credentials)
    .where(
      and(
        eq(schema.credentials.userId, userId),
        eq(schema.credentials.credentialType, 'cloud-provider')
      )
    )
    .limit(1);

  if (!credential) {
    throw errors.badRequest('Cloud provider credentials required. Connect your account in Settings.');
  }

  // Parse request body (optional — empty body means use defaults)
  const body = await parseOptionalBody(c.req.raw, RunTaskSchema, {} as Record<string, never>);

  // vmSize, workspaceProfile validated by schema (picklist)

  // vmLocation validated as string by schema
  // workspaceProfile validated by schema (picklist)

  // Load project for repository/installationId
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.userId, userId)
      )
    )
    .limit(1);

  if (!project) {
    throw errors.notFound('Project');
  }

  const provider: CredentialProvider | null =
    typeof project.defaultProvider === 'string' && isValidProvider(project.defaultProvider)
      ? project.defaultProvider
      : null;
  const audit = resolveTaskStartAudit({
    taskId: task.id,
    projectId,
    userId,
    explicit: {
      vmSize: body.vmSize ?? null,
      vmLocation: body.vmLocation as VMLocation | null,
      workspaceProfile: body.workspaceProfile ?? null,
      taskMode: task.taskMode as import('@simple-agent-manager/shared').TaskMode,
      resourceRequirements: parseResourceRequirementsJson(task.resourceRequirementsJson, 'task resource requirements'),
    },
    project: {
      defaultVmSize: project.defaultVmSize as VMSize | null,
      defaultProvider: provider,
      defaultLocation: project.defaultLocation as VMLocation | null,
      defaultWorkspaceProfile: project.defaultWorkspaceProfile as WorkspaceProfile | null,
      defaultResourceRequirements: parseResourceRequirementsJson(project.defaultResourceRequirementsJson, 'project resource requirements'),
    },
    taskModeFallback: 'workspace-profile',
  });
  const vmSize = audit.vmSize;
  const providerForRun = audit.provider;
  const vmLocation = audit.vmLocation;
  const workspaceProfile = audit.workspaceProfile;
  const devcontainerConfigName: string | null = workspaceProfile === 'lightweight'
    ? null
    : (body.devcontainerConfigName ?? project.defaultDevcontainerConfigName ?? null);
  const branch = body.branch ?? project.defaultBranch;

  // Validate location against provider
  if (providerForRun !== null && !isValidLocationForProvider(providerForRun, vmLocation)) {
    const validLocations = getLocationsForProvider(providerForRun).map((l) => l.id);
    throw errors.badRequest(
      `Location '${vmLocation}' is not valid for provider '${providerForRun}'. Valid locations: ${validLocations.join(', ')}`
    );
  }

  // Look up user's githubId for noreply email fallback
  const [userRow] = await db
    .select({ githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // Transition task to queued with initial execution step (optimistic lock on 'ready')
  const now = new Date().toISOString();
  const transitionResult = await c.env.DATABASE.prepare(
    `UPDATE tasks SET status = 'queued', execution_step = 'node_selection',
     requested_vm_size = ?, requested_vm_size_source = ?,
     requested_provider = ?, requested_provider_source = ?,
     requested_vm_location = ?, requested_vm_location_source = ?,
     requested_workspace_profile = ?, requested_workspace_profile_source = ?,
     requested_task_mode = ?, requested_task_mode_source = ?,
     resource_requirements_json = ?, resource_requirements_source = ?,
     resolved_reservation_json = ?, updated_at = ?
     WHERE id = ? AND status = 'ready'`
  ).bind(
    vmSize, audit.vmSizeSource,
    providerForRun, audit.providerSource,
    vmLocation, audit.vmLocationSource,
    workspaceProfile, audit.workspaceProfileSource,
    audit.taskMode, audit.taskModeSource,
    audit.resources.resourceRequirementsJson, audit.resources.resourceRequirementsSource,
    audit.resources.resolvedReservationJson,
    now, task.id,
  ).run();

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
      task.id
    );
  } catch (err) {
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Session creation failed: ${errorMsg}`, updatedAt: failedAt })
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
      agentType: project.defaultAgentType ?? null,
      workspaceProfile,
      devcontainerConfigName,
      cloudProvider: providerForRun,
      taskMode: audit.taskMode,
      // Agent profile resolution is not supported on the kanban Run path — tasks
      // re-run with project defaults. Profile support (model, permissionMode,
      // systemPromptAppend) deferred to a future PR.
      model: null,
      permissionMode: null,
      projectScaling: {
        taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
        maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
        nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
      },
      resourceRequirements: audit.resources.resourceRequirements,
      resolvedReservation: audit.resources.resolvedReservation,
      vmSizeSource: audit.vmSizeSource,
    });
  } catch (err) {
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Task runner startup failed: ${errorMsg}`, updatedAt: failedAt })
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
      log.error('task_run.orphaned_session_stop_failed', { projectId, sessionId, error: String(e) });
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

  await requireOwnedProject(db, projectId, userId);
  const task = await requireOwnedTask(db, projectId, taskId, userId);

  // Only allow cleanup for terminal states
  if (
    task.status !== 'completed' &&
    task.status !== 'failed' &&
    task.status !== 'cancelled'
  ) {
    throw errors.conflict(
      `Task must be in completed, failed, or cancelled status for cleanup, currently '${task.status}'`
    );
  }

  c.executionCtx.waitUntil(cleanupTaskRun(task.id, c.env));

  return c.json({ success: true, message: 'Cleanup initiated' });
});

export { runRoutes };
