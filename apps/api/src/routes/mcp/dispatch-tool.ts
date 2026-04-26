/**
 * MCP dispatch_task tool — spawns a new task in the current project.
 *
 * Supports full task execution configuration parity with the normal submit path:
 * agentProfileId, taskMode, agentType, workspaceProfile, provider, vmLocation.
 *
 * Config precedence: explicit field → profile value → project default → platform default.
 */
import type { CredentialProvider, TaskMode, VMLocation, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { CREDENTIAL_PROVIDERS, DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE, DEFAULT_WORKSPACE_PROFILE, DEVCONTAINER_CONFIG_NAME_MAX_LENGTH, DEVCONTAINER_CONFIG_NAME_REGEX, getDefaultLocationForProvider, getLocationsForProvider, isValidAgentType, isValidLocationForProvider, isValidProvider } from '@simple-agent-manager/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { resolveAgentProfile } from '../../services/agent-profiles';
import { generateBranchName } from '../../services/branch-name';
import { resolveProjectAgentDefault } from '../../services/project-agent-defaults';
import * as projectDataService from '../../services/project-data';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../../services/task-title';
import {
  ACTIVE_STATUSES,
  getMcpLimits,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

/** Valid task modes for dispatch */
const VALID_TASK_MODES: TaskMode[] = ['task', 'conversation'];
/** Valid workspace profiles for dispatch */
const VALID_WORKSPACE_PROFILES: WorkspaceProfile[] = ['full', 'lightweight'];

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

  // ── Validate new config parameters ──────────────────────────────────────

  // agentProfileId — validated later via resolveAgentProfile
  const agentProfileId = typeof params.agentProfileId === 'string' ? params.agentProfileId.trim() : undefined;
  if (params.agentProfileId !== undefined && !agentProfileId) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'agentProfileId must be a non-empty string');
  }

  // taskMode
  let explicitTaskMode: TaskMode | undefined;
  if (params.taskMode !== undefined) {
    if (typeof params.taskMode !== 'string' || !VALID_TASK_MODES.includes(params.taskMode as TaskMode)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `taskMode must be one of: ${VALID_TASK_MODES.join(', ')}`);
    }
    explicitTaskMode = params.taskMode as TaskMode;
  }

  // agentType
  let explicitAgentType: string | undefined;
  if (params.agentType !== undefined) {
    if (typeof params.agentType !== 'string' || !isValidAgentType(params.agentType)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `agentType is not a recognized agent type`);
    }
    explicitAgentType = params.agentType;
  }

  // workspaceProfile
  let explicitWorkspaceProfile: WorkspaceProfile | undefined;
  if (params.workspaceProfile !== undefined) {
    if (typeof params.workspaceProfile !== 'string' || !VALID_WORKSPACE_PROFILES.includes(params.workspaceProfile as WorkspaceProfile)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `workspaceProfile must be one of: ${VALID_WORKSPACE_PROFILES.join(', ')}`);
    }
    explicitWorkspaceProfile = params.workspaceProfile as WorkspaceProfile;
  }

  // devcontainerConfigName
  let explicitDevcontainerConfigName: string | null | undefined;
  if (params.devcontainerConfigName !== undefined) {
    if (params.devcontainerConfigName === null) {
      explicitDevcontainerConfigName = null;
    } else if (typeof params.devcontainerConfigName !== 'string' || !DEVCONTAINER_CONFIG_NAME_REGEX.test(params.devcontainerConfigName)) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'devcontainerConfigName must be alphanumeric with hyphens/underscores');
    } else if (params.devcontainerConfigName.length > DEVCONTAINER_CONFIG_NAME_MAX_LENGTH) {
      return jsonRpcError(requestId, INVALID_PARAMS, `devcontainerConfigName must be at most ${DEVCONTAINER_CONFIG_NAME_MAX_LENGTH} characters`);
    } else {
      explicitDevcontainerConfigName = params.devcontainerConfigName;
    }
  }

  // provider
  let explicitProvider: CredentialProvider | undefined;
  if (params.provider !== undefined) {
    if (typeof params.provider !== 'string' || !CREDENTIAL_PROVIDERS.includes(params.provider as CredentialProvider)) {
      return jsonRpcError(requestId, INVALID_PARAMS, `provider must be one of: ${CREDENTIAL_PROVIDERS.join(', ')}`);
    }
    explicitProvider = params.provider as CredentialProvider;
  }

  // vmLocation — validated against provider after resolution
  let explicitVmLocation: string | undefined;
  if (params.vmLocation !== undefined) {
    if (typeof params.vmLocation !== 'string' || params.vmLocation.trim().length === 0) {
      return jsonRpcError(requestId, INVALID_PARAMS, 'vmLocation must be a non-empty string');
    }
    explicitVmLocation = params.vmLocation.trim();
  }

  // missionId — inherit from parent task or explicit override
  const explicitMissionId = typeof params.missionId === 'string' ? params.missionId.trim() : undefined;

  // ── Look up current task to get dispatch depth ──────────────────────────
  const [currentTask] = await db
    .select({
      id: schema.tasks.id,
      dispatchDepth: schema.tasks.dispatchDepth,
      status: schema.tasks.status,
      missionId: schema.tasks.missionId,
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

  // ── Compute new depth (enforcement deferred until project overrides are resolved) ──
  const newDepth = currentTask.dispatchDepth + 1;

  // ── Parallel: pre-flight checks, project fetch, and AI title ────────────
  const titleConfig = getTaskTitleConfig(env);
  const [
    [childCountResult],
    [activeDispatchedResult],
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
    db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, tokenData.projectId))
      .limit(1),
    generateTaskTitle(env.AI, description, titleConfig),
  ]);

  // ── Apply per-project overrides to dispatch limits ──────────────────────
  const effectiveMaxDepth = project?.maxDispatchDepth ?? limits.dispatchMaxDepth;
  const effectiveMaxPerTask = project?.maxSubTasksPerTask ?? limits.dispatchMaxPerTask;
  const effectiveMaxActive = project?.maxConcurrentTasks ?? limits.dispatchMaxActivePerProject;

  // Re-check depth with project override (initial check above used platform default)
  if (newDepth > effectiveMaxDepth) {
    log.warn('mcp.dispatch_task.depth_exceeded', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      currentDepth: currentTask.dispatchDepth,
      maxDepth: effectiveMaxDepth,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Dispatch depth limit exceeded. Current depth: ${currentTask.dispatchDepth}, max allowed: ${effectiveMaxDepth}. ` +
      'Agent-dispatched tasks have a depth limit to prevent runaway recursive spawning.',
    );
  }

  // ── Advisory pre-checks (fast-fail before expensive operations) ─────────
  const childCount = childCountResult?.count ?? 0;
  if (childCount >= effectiveMaxPerTask) {
    log.warn('mcp.dispatch_task.per_task_limit', {
      taskId: tokenData.taskId,
      projectId: tokenData.projectId,
      childCount,
      maxPerTask: effectiveMaxPerTask,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Per-task dispatch limit reached (${childCount}/${effectiveMaxPerTask}). ` +
      'A single agent can only dispatch a limited number of tasks to prevent resource exhaustion.',
    );
  }

  const activeDispatched = activeDispatchedResult?.count ?? 0;
  if (activeDispatched >= effectiveMaxActive) {
    log.warn('mcp.dispatch_task.project_active_limit', {
      projectId: tokenData.projectId,
      activeDispatched,
      maxActive: effectiveMaxActive,
    });
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Project has ${activeDispatched} active agent-dispatched tasks (limit: ${effectiveMaxActive}). ` +
      'Wait for existing tasks to complete before dispatching more.',
    );
  }

  // ── Verify project exists ──────────────────────────────────────────────
  if (!project) {
    return jsonRpcError(requestId, INTERNAL_ERROR, 'Project not found');
  }

  // ── Resolve agent profile ───────────────────────────────────────────────
  // Same pattern as submit.ts — resolveAgentProfile handles ID/name lookup
  // with built-in profile seeding.
  const resolvedProfile = agentProfileId
    ? await resolveAgentProfile(db, tokenData.projectId, agentProfileId, tokenData.userId, env)
    : null;

  // ── Build the task description with references ──────────────────────────
  let fullDescription = description;
  if (references.length > 0) {
    fullDescription += '\n\n## References\n' + references.map((r) => `- ${r}`).join('\n');
  }

  // ── Propagate active project policies to child tasks ──────────────────
  // When dispatching within a mission, append active policies so sub-agents
  // inherit the same rules/constraints without needing to call get_instructions.
  if (explicitMissionId ?? currentTask.missionId) {
    try {
      const activePolicies = await projectDataService.getActivePolicies(env, tokenData.projectId);
      if (activePolicies.length > 0) {
        const categoryLabels: Record<string, string> = {
          rule: 'RULE',
          constraint: 'CONSTRAINT',
          delegation: 'DELEGATION',
          preference: 'PREFERENCE',
        };
        const policyLines = activePolicies.map(
          (p) => `- [${categoryLabels[p.category] || p.category.toUpperCase()}] ${p.title}: ${p.content}`,
        );
        fullDescription += '\n\n## Project Policies (inherited)\n' + policyLines.join('\n');
      }
    } catch (err) {
      log.warn('mcp.dispatch_task.policy_propagation_failed', {
        projectId: tokenData.projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Enforce length limit on the final description (after reference + policy concatenation)
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

  // ── Resolve config (explicit → profile → project default → platform default) ──
  const resolvedVmSize: VMSize = vmSize
    ?? (resolvedProfile?.vmSizeOverride as VMSize | null)
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;

  const profileProvider =
    typeof resolvedProfile?.provider === 'string' && isValidProvider(resolvedProfile.provider)
      ? resolvedProfile.provider
      : null;
  const projectDefaultProvider =
    typeof project.defaultProvider === 'string' && isValidProvider(project.defaultProvider)
      ? project.defaultProvider
      : null;
  const resolvedProvider: CredentialProvider | null = explicitProvider
    ?? profileProvider
    ?? projectDefaultProvider
    ?? null;

  const resolvedVmLocation: VMLocation = (explicitVmLocation as VMLocation)
    ?? (resolvedProfile?.vmLocation as VMLocation | null)
    ?? (project.defaultLocation as VMLocation | null)
    ?? (resolvedProvider ? getDefaultLocationForProvider(resolvedProvider) as VMLocation | null : null)
    ?? DEFAULT_VM_LOCATION;

  const resolvedWorkspaceProfile: WorkspaceProfile = explicitWorkspaceProfile
    ?? (resolvedProfile?.workspaceProfile as WorkspaceProfile | null)
    ?? (project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;

  // Devcontainer config name: explicit → profile → project default → null (auto-discover).
  // Irrelevant when workspace profile is 'lightweight' (devcontainer build skipped entirely).
  const resolvedDevcontainerConfigName: string | null = resolvedWorkspaceProfile === 'lightweight'
    ? null
    : (explicitDevcontainerConfigName
      ?? resolvedProfile?.devcontainerConfigName
      ?? project.defaultDevcontainerConfigName
      ?? null);

  // Validate location against resolved provider
  if (resolvedProvider !== null && !isValidLocationForProvider(resolvedProvider, resolvedVmLocation)) {
    const validLocations = getLocationsForProvider(resolvedProvider).map((l) => l.id);
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `Location '${resolvedVmLocation}' is not valid for provider '${resolvedProvider}'. Valid locations: ${validLocations.join(', ')}`,
    );
  }

  // Task mode: explicit → profile → inferred from workspace profile → default 'task'
  const resolvedTaskMode: TaskMode = explicitTaskMode
    ?? (resolvedProfile?.taskMode as TaskMode | null)
    ?? (resolvedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task');

  // Agent type: explicit → profile → project default → platform default
  const resolvedAgentType: string | null = explicitAgentType
    ?? resolvedProfile?.agentType
    ?? project.defaultAgentType
    ?? null;

  // Explicit branch > project default branch.
  const checkoutBranch = explicitBranch || project.defaultBranch;

  // ── Verify cloud credentials and enforce quota ──────────────────────────
  // Uses resolveCredentialSource to determine whether the user's own credential
  // or a platform credential will be used for the resolved provider. Quota is
  // enforced only when platform credentials are used.
  const { resolveCredentialSource } = await import('../../services/provider-credentials');
  const credResult = await resolveCredentialSource(db, tokenData.userId, resolvedProvider ?? undefined);

  if (!credResult) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'Cloud provider credentials required. The user must connect a cloud provider in Settings.',
    );
  }

  if (credResult.credentialSource === 'platform') {
    const quotaEnforcementEnabled = env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false';
    if (quotaEnforcementEnabled) {
      const { checkQuotaForUser } = await import('../../services/compute-quotas');
      const quotaCheck = await checkQuotaForUser(db, tokenData.userId);
      if (!quotaCheck.allowed) {
        return jsonRpcError(
          requestId,
          INVALID_PARAMS,
          `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
          'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.',
        );
      }
    }
  }

  // ── Atomic conditional INSERT (prevents TOCTOU race) ─────────────────
  const statusPlaceholders = ACTIVE_STATUSES.map(() => '?').join(', ');
  const conditionalInsertResult = await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, parent_task_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     task_mode, agent_profile_hint, mission_id,
     created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, 'queued', 'node_selection', ?, ?, ?, ?,
     ?, ?, ?,
     ?, ?
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
    tokenData.userId,
    resolvedTaskMode, resolvedProfile?.profileId ?? null,
    explicitMissionId ?? currentTask.missionId ?? null,
    now, now,
    // Per-task child count subquery
    tokenData.taskId, tokenData.projectId,
    ...ACTIVE_STATUSES,
    effectiveMaxPerTask,
    // Per-project active count subquery
    tokenData.projectId,
    ...ACTIVE_STATUSES,
    effectiveMaxActive,
  ).run();

  if (!conditionalInsertResult.meta.changes || conditionalInsertResult.meta.changes === 0) {
    log.warn('mcp.dispatch_task.atomic_limit_breach', {
      taskId,
      projectId: tokenData.projectId,
      maxPerTask: effectiveMaxPerTask,
      maxActive: effectiveMaxActive,
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
      agentType: resolvedAgentType,
      workspaceProfile: resolvedWorkspaceProfile,
      devcontainerConfigName: resolvedDevcontainerConfigName,
      cloudProvider: resolvedProvider,
      taskMode: resolvedTaskMode,
      // Resolution chain: agent profile > project.agentDefaults[agentType] > null (VM agent
      // falls through to user agent_settings via callback, then platform default).
      model:
        resolvedProfile?.model ??
        resolveProjectAgentDefault(project.agentDefaults, resolvedAgentType).model,
      permissionMode:
        resolvedProfile?.permissionMode ??
        resolveProjectAgentDefault(project.agentDefaults, resolvedAgentType).permissionMode,
      // OpenCode settings: VM agent fetches user-level settings via callback
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: resolvedProfile?.systemPromptAppend ?? null,
      projectScaling: {
        taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
        maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
        nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
      },
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
          agentProfileId: agentProfileId ?? undefined,
          taskMode: resolvedTaskMode,
        },
      }),
    }));
  } catch (err) {
    log.warn('mcp.dispatch_task.activity_event_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Recompute scheduler states if the new task belongs to a mission (best-effort)
  const resolvedMissionId = explicitMissionId ?? currentTask.missionId ?? null;
  if (resolvedMissionId) {
    try {
      await recomputeMissionSchedulerStates(env.DATABASE, resolvedMissionId);
    } catch (err) {
      log.warn('mcp.dispatch_task.scheduler_state_recompute_failed', {
        taskId,
        missionId: resolvedMissionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('mcp.dispatch_task.created', {
    taskId,
    sessionId,
    branchName,
    parentTaskId: tokenData.taskId,
    projectId: tokenData.projectId,
    dispatchDepth: newDepth,
    vmSize: resolvedVmSize,
    vmLocation: resolvedVmLocation,
    taskMode: resolvedTaskMode,
    agentType: resolvedAgentType,
    agentProfileId: agentProfileId ?? null,
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
