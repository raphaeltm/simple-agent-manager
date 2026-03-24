/**
 * MCP dispatch_task tool — spawns a new task in the current project.
 */
import { and, eq, sql, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { VMSize, VMLocation, WorkspaceProfile, CredentialProvider } from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION, DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { generateBranchName } from '../../services/branch-name';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../../services/task-title';
import * as projectDataService from '../../services/project-data';
import {
  type McpTokenData,
  type JsonRpcResponse,
  jsonRpcSuccess,
  jsonRpcError,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  ACTIVE_STATUSES,
  getMcpLimits,
} from './_helpers';

export async function handleDispatchTask(
  requestId: string | number | null,
  params: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env,
): Promise<JsonRpcResponse> {
  const limits = getMcpLimits(env);
  const db = drizzle(env.DATABASE, { schema });

  // ── Validate description ────────────────────────────────────────────────
  const description = typeof params.description === 'string' ? params.description.trim() : '';
  if (!description) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'description is required and must be a non-empty string');
  }
  if (description.length > limits.dispatchDescriptionMaxLength) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `description exceeds maximum length of ${limits.dispatchDescriptionMaxLength} characters`,
    );
  }

  let vmSize: VMSize | undefined;
  if (params.vmSize !== undefined) {
    if (typeof params.vmSize !== 'string' || !['small', 'medium', 'large'].includes(params.vmSize)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'vmSize must be small, medium, or large');
    }
    vmSize = params.vmSize as VMSize;
  }

  // Clamp priority to [0, max] to prevent agents from monopolizing the task queue
  const priority = typeof params.priority === 'number'
    ? Math.min(Math.max(0, Math.round(params.priority)), limits.dispatchMaxPriority)
    : 0;
  const references = Array.isArray(params.references)
    ? params.references
        .filter((r): r is string => typeof r === 'string')
        .slice(0, limits.dispatchMaxReferences)
        .map((r) => r.slice(0, limits.dispatchMaxReferenceLength))
    : [];

  // Validate optional branch parameter
  let explicitBranch: string | undefined;
  if (params.branch !== undefined) {
    if (typeof params.branch !== 'string' || params.branch.trim().length === 0) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'branch must be a non-empty string');
    }
    explicitBranch = params.branch.trim();
  }

  // ── Look up current task to get dispatch depth ──────────────────────────
  const [currentTask] = await db
    .select({
      id: schema.tasks.id,
      dispatchDepth: schema.tasks.dispatchDepth,
      status: schema.tasks.status,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
      ),
    )
    .limit(1);

  if (!currentTask) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Current task not found');
  }

  if (!ACTIVE_STATUSES.includes(currentTask.status)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Cannot dispatch from a task in '${currentTask.status}' status`,
    );
  }

  // ── Enforce dispatch depth limit ────────────────────────────────────────
  const newDepth = currentTask.dispatchDepth + 1;
  if (newDepth > limits.dispatchMaxDepth) {
    log.warn('mcp.dispatch_task.depth_exceeded', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      currentDepth: currentTask.dispatchDepth,
      maxDepth: limits.dispatchMaxDepth,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Dispatch depth limit exceeded. Current depth: ${currentTask.dispatchDepth}, max allowed: ${limits.dispatchMaxDepth}. ` +
      'Agent-dispatched tasks have a depth limit to prevent runaway recursive spawning.',
    );
  }

  // ── Parallel: pre-flight checks, credential check, project fetch, and AI title ─
  // These queries are independent of each other (only depend on currentTask for depth,
  // which was already checked above). Running them in parallel saves 4 sequential D1
  // round-trips + 1 Workers AI call.
  // The COUNT queries here are advisory (fast-fail). Atomic enforcement happens later
  // via D1 batch (COUNT + INSERT in implicit transaction) to prevent TOCTOU races.
  const titleConfig = getTaskTitleConfig(env);
  const [
    [childCountResult],
    [activeDispatchedResult],
    [credential],
    [project],
    taskTitle,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.parentTaskId, tokenData.taskId),
        eq(schema.tasks.projectId, tokenData.projectId),
        inArray(schema.tasks.status, ACTIVE_STATUSES),
      )),
    db.select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(and(
        eq(schema.tasks.projectId, tokenData.projectId),
        inArray(schema.tasks.status, ACTIVE_STATUSES),
        sql`${schema.tasks.dispatchDepth} > 0`,
      )),
    db.select({ id: schema.credentials.id })
      .from(schema.credentials)
      .where(and(
        eq(schema.credentials.userId, tokenData.userId),
        eq(schema.credentials.credentialType, 'cloud-provider'),
      ))
      .limit(1),
    db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, tokenData.projectId))
      .limit(1),
    generateTaskTitle(env.AI, description, titleConfig),
  ]);

  // ── Advisory pre-checks (fast-fail before expensive operations) ─────────
  const childCount = childCountResult?.count ?? 0;
  if (childCount >= limits.dispatchMaxPerTask) {
    log.warn('mcp.dispatch_task.per_task_limit', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      childCount,
      maxPerTask: limits.dispatchMaxPerTask,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Per-task dispatch limit reached (${childCount}/${limits.dispatchMaxPerTask}). ` +
      'A single agent can only dispatch a limited number of tasks to prevent resource exhaustion.',
    );
  }

  const activeDispatched = activeDispatchedResult?.count ?? 0;
  if (activeDispatched >= limits.dispatchMaxActivePerProject) {
    log.warn('mcp.dispatch_task.project_active_limit', {
      projectId: tokenData.projectId,
      activeDispatched,
      maxActive: limits.dispatchMaxActivePerProject,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Project has ${activeDispatched} active agent-dispatched tasks (limit: ${limits.dispatchMaxActivePerProject}). ` +
      'Wait for existing tasks to complete before dispatching more.',
    );
  }

  // ── Verify cloud credentials exist for the user ─────────────────────────
  if (!credential) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Cloud provider credentials required. The user must connect a cloud provider in Settings.',
    );
  }

  // ── Verify project exists ──────────────────────────────────────────────
  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  // ── Build the task description with references ──────────────────────────
  let fullDescription = description;
  if (references.length > 0) {
    fullDescription += '\n\n## References\n' + references.map((r) => `- ${r}`).join('\n');
  }
  // Enforce length limit on the final description (after reference concatenation)
  if (fullDescription.length > limits.dispatchDescriptionMaxLength) {
    fullDescription = fullDescription.slice(0, limits.dispatchDescriptionMaxLength);
  }

  // ── Create the task ─────────────────────────────────────────────────────
  const taskId = ulid();
  const now = new Date().toISOString();

  // Generate branch name (CPU-only, no I/O)
  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(description, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  // Determine VM config (explicit > project default > platform default)
  const resolvedVmSize: VMSize = vmSize
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;
  const resolvedVmLocation: VMLocation = DEFAULT_VM_LOCATION;
  const resolvedWorkspaceProfile: WorkspaceProfile = (project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;
  const resolvedProvider: CredentialProvider | null = (project.defaultProvider as CredentialProvider | null) ?? null;

  // Explicit branch > project default branch.
  // We intentionally do NOT fall back to the parent task's outputBranch because
  // that branch may never have been pushed to the remote (it's generated at task
  // creation time, not on push). If an agent wants a child task on its branch,
  // it must pass `branch` explicitly — which implies it has already pushed.
  const checkoutBranch = explicitBranch || project.defaultBranch;

  // ── Atomic conditional INSERT (prevents TOCTOU race) ─────────────────
  // Uses INSERT ... SELECT ... WHERE to embed the rate-limit check as a
  // subquery within a single SQL statement. SQLite evaluates the WHERE
  // clause atomically — if a concurrent request inserts a task between
  // our advisory pre-check and this statement, the subquery count will
  // reflect it and the INSERT will produce zero rows. No phantom rows,
  // no compensating cancellation needed.
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const conditionalInsertResult = await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, parent_task_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, 'queued', 'node_selection', ?, ?, ?, ?, ?, ?
     WHERE (
       SELECT count(*) FROM tasks
       WHERE parent_task_id = ? AND project_id = ?
       AND status IN (${statusPlaceholders})
     ) < ?
     AND (
       SELECT count(*) FROM tasks
       WHERE project_id = ? AND status IN (${statusPlaceholders})
       AND dispatch_depth > 0
     ) < ?`,
  ).bind(
    // INSERT values
    taskId, tokenData.projectId, tokenData.userId, tokenData.taskId,
    taskTitle, fullDescription, priority, newDepth, branchName,
    tokenData.userId, now, now,
    // Per-task child count subquery
    tokenData.taskId, tokenData.projectId,
    ...ACTIVE_STATUSES,
    limits.dispatchMaxPerTask,
    // Per-project active count subquery
    tokenData.projectId,
    ...ACTIVE_STATUSES,
    limits.dispatchMaxActivePerProject,
  ).run();

  if (!conditionalInsertResult.meta.changes || conditionalInsertResult.meta.changes === 0) {
    // The conditional INSERT produced zero rows — a concurrent dispatch
    // pushed the count over the limit between our advisory check and now.
    log.warn('mcp.dispatch_task.atomic_limit_breach', {
      taskId,
      projectId: tokenData.projectId,
      maxPerTask: limits.dispatchMaxPerTask,
      maxActive: limits.dispatchMaxActivePerProject,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Dispatch rate limit exceeded (concurrent dispatch detected). Please retry.',
    );
  }

  // Record status event: null -> queued
  const statusEventId = ulid();
  await env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status,
     actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', 'agent', ?, ?, ?)`,
  ).bind(
    statusEventId, taskId, tokenData.workspaceId,
    `Dispatched by agent (depth ${newDepth}, parent task ${tokenData.taskId})`,
    now,
  ).run();

  // ── Create chat session and persist initial message ─────────────────────
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      env,
      tokenData.projectId,
      null, // workspaceId — linked later by TaskRunner DO
      taskTitle,
      taskId,
    );

    // Persist the description as the initial user message
    await projectDataService.persistMessage(
      env,
      tokenData.projectId,
      sessionId,
      'user',
      fullDescription,
      null,
    );
  } catch (err) {
    // Session creation failed — mark task as failed
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Session creation failed: ${errorMsg}`, updatedAt: failedAt })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Session creation failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('mcp.dispatch_task.session_failed', { taskId, projectId: tokenData.projectId, error: errorMsg });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to create chat session: ${errorMsg}`);
  }

  // ── Start TaskRunner DO ─────────────────────────────────────────────────
  // Look up user's githubId for noreply email fallback
  const [userRow] = await db
    .select({ name: schema.users.name, email: schema.users.email, githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, tokenData.userId))
    .limit(1);

  try {
    await startTaskRunnerDO(env, {
      taskId,
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      vmSize: resolvedVmSize,
      vmLocation: resolvedVmLocation,
      branch: checkoutBranch,
      userName: userRow?.name ?? null,
      userEmail: userRow?.email ?? null,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: fullDescription,
      repository: project.repository,
      installationId: project.installationId,
      outputBranch: branchName,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType: project.defaultAgentType ?? null,
      workspaceProfile: resolvedWorkspaceProfile,
      cloudProvider: resolvedProvider,
    });
  } catch (err) {
    // TaskRunner DO startup failed — mark task as failed
    const failedAt = new Date().toISOString();
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db.update(schema.tasks)
      .set({ status: 'failed', errorMessage: `Task runner startup failed: ${errorMsg}`, updatedAt: failedAt })
      .where(eq(schema.tasks.id, taskId));
    await db.insert(schema.taskStatusEvents).values({
      id: ulid(),
      taskId,
      fromStatus: 'queued',
      toStatus: 'failed',
      actorType: 'system',
      actorId: null,
      reason: `Task runner startup failed: ${errorMsg}`,
      createdAt: failedAt,
    });
    log.error('mcp.dispatch_task.do_startup_failed', { taskId, projectId: tokenData.projectId, error: errorMsg });
    await projectDataService.stopSession(env, tokenData.projectId, sessionId).catch((e) => {
      log.error('mcp.dispatch_task.orphaned_session_stop_failed', { projectId: tokenData.projectId, sessionId, error: String(e) });
    });
    return jsonRpcError(requestId, INTERNAL_ERROR, `Failed to start task runner: ${errorMsg}`);
  }

  // ── Record activity event (best-effort) ─────────────────────────────────
  try {
    const doId = env.PROJECT_DATA.idFromName(tokenData.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(new Request('https://do/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task.dispatched',
        actorType: 'agent',
        actorId: tokenData.workspaceId,
        metadata: {
          taskId,
          parentTaskId: tokenData.taskId,
          dispatchDepth: newDepth,
          title: taskTitle,
          branchName,
        },
      }),
    }));
  } catch (err) {
    log.warn('mcp.dispatch_task.activity_event_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('mcp.dispatch_task.created', {
    taskId,
    sessionId,
    branchName,
    parentTaskId: tokenData.taskId,
    projectId: tokenData.projectId,
    dispatchDepth: newDepth,
    vmSize: resolvedVmSize,
  });

  const appDomain = `app.${env.BASE_DOMAIN}`;
  const taskUrl = `https://${appDomain}/projects/${tokenData.projectId}/ideas/${taskId}`;

  return jsonRpcSuccess(requestId, {
    content: [{
      type: 'text',
      text: JSON.stringify({
        taskId,
        sessionId,
        branchName,
        title: taskTitle,
        status: 'queued',
        dispatchDepth: newDepth,
        url: taskUrl,
        message: `Task dispatched successfully. The agent will start working independently. Track progress at: ${taskUrl}`,
      }, null, 2),
    }],
  });
}
