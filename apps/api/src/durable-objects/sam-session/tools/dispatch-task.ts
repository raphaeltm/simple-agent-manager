/**
 * SAM dispatch_task tool — submit a task to a project.
 *
 * Unlike the MCP dispatch_task (which runs within a workspace context with
 * depth tracking and parent task), SAM dispatches on behalf of the user
 * with no parent task or depth constraints.
 */
import type {
  CredentialProvider,
  TaskMode,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  getLocationsForProvider,
  isValidAgentType,
  isValidLocationForProvider,
  isValidProvider,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { ulid } from '../../../lib/ulid';
import { resolveAgentProfile } from '../../../services/agent-profiles';
import { generateBranchName } from '../../../services/branch-name';
import { resolveProjectAgentDefault } from '../../../services/project-agent-defaults';
import * as projectDataService from '../../../services/project-data';
import { startTaskRunnerDO } from '../../../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../../../services/task-title';
import type { AnthropicToolDef, ToolContext } from '../types';

const VALID_TASK_MODES: TaskMode[] = ['task', 'conversation'];
const VALID_WORKSPACE_PROFILES: WorkspaceProfile[] = ['full', 'lightweight'];
const DEFAULT_MAX_DESCRIPTION_LENGTH = 32_000;

export const dispatchTaskDef: AnthropicToolDef = {
  name: 'dispatch_task',
  description:
    'Submit a task to a project — provisions a workspace and runs an AI coding agent. ' +
    'Use this when the user wants to delegate work to an agent. Returns the task ID and tracking URL.',
  input_schema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The project ID to dispatch the task to.',
      },
      description: {
        type: 'string',
        description: 'The task description / instructions for the agent.',
      },
      agentType: {
        type: 'string',
        description: 'Agent type (e.g. "claude-code", "openai-codex"). Uses project default if omitted.',
      },
      vmSize: {
        type: 'string',
        enum: ['small', 'medium', 'large'],
        description: 'VM size for the workspace. Uses project default if omitted.',
      },
      workspaceProfile: {
        type: 'string',
        enum: ['full', 'lightweight'],
        description: 'Workspace profile. "full" includes devcontainer build, "lightweight" skips it.',
      },
      priority: {
        type: 'number',
        description: 'Task priority (0 = normal). Higher is more urgent.',
      },
      branch: {
        type: 'string',
        description: 'Git branch to check out. Uses project default branch if omitted.',
      },
      taskMode: {
        type: 'string',
        enum: ['task', 'conversation'],
        description: '"task" = agent pushes code + creates PR. "conversation" = interactive session.',
      },
      agentProfileId: {
        type: 'string',
        description: 'Agent profile ID or name to use for configuration.',
      },
      missionId: {
        type: 'string',
        description: 'Mission ID to associate this task with. Use after create_mission.',
      },
    },
    required: ['projectId', 'description'],
  },
};

interface DispatchTaskInput {
  projectId: string;
  description: string;
  agentType?: string;
  vmSize?: string;
  workspaceProfile?: string;
  priority?: number;
  branch?: string;
  taskMode?: string;
  agentProfileId?: string;
  missionId?: string;
}

export async function dispatchTask(
  input: DispatchTaskInput,
  ctx: ToolContext,
): Promise<unknown> {
  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });

  // ── Validate required params ───────────────────────────────────────────
  if (!input.projectId?.trim()) {
    return { error: 'projectId is required.' };
  }
  if (!input.description?.trim()) {
    return { error: 'description is required.' };
  }

  const maxDescLen = Number(env.SAM_DISPATCH_MAX_DESCRIPTION_LENGTH) || DEFAULT_MAX_DESCRIPTION_LENGTH;
  const description = input.description.trim().slice(0, maxDescLen);

  // ── Validate optional params (before any DB access) ───────────────────
  let vmSize: VMSize | undefined;
  if (input.vmSize !== undefined) {
    if (!['small', 'medium', 'large'].includes(input.vmSize)) {
      return { error: 'vmSize must be small, medium, or large.' };
    }
    vmSize = input.vmSize as VMSize;
  }

  if (input.agentType !== undefined && !isValidAgentType(input.agentType)) {
    return { error: 'Unrecognized agentType.' };
  }

  if (input.workspaceProfile !== undefined && !VALID_WORKSPACE_PROFILES.includes(input.workspaceProfile as WorkspaceProfile)) {
    return { error: `workspaceProfile must be one of: ${VALID_WORKSPACE_PROFILES.join(', ')}` };
  }

  if (input.taskMode !== undefined && !VALID_TASK_MODES.includes(input.taskMode as TaskMode)) {
    return { error: `taskMode must be one of: ${VALID_TASK_MODES.join(', ')}` };
  }

  const priority = typeof input.priority === 'number'
    ? Math.min(Math.max(0, Math.round(input.priority)), 10)
    : 0;

  // ── Verify ownership ──────────────────────────────────────────────────
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!project) {
    return { error: 'Project not found or not owned by you.' };
  }

  // ── Resolve agent profile ────────────────────────────────────────────
  const resolvedProfile = input.agentProfileId
    ? await resolveAgentProfile(db, input.projectId, input.agentProfileId, ctx.userId, env)
    : null;

  // ── Resolve config (explicit → profile → project default → platform default) ──
  const profileProvider =
    typeof resolvedProfile?.provider === 'string' && isValidProvider(resolvedProfile.provider)
      ? resolvedProfile.provider
      : null;
  const projectDefaultProvider =
    typeof project.defaultProvider === 'string' && isValidProvider(project.defaultProvider)
      ? project.defaultProvider
      : null;
  const resolvedProvider: CredentialProvider | null = profileProvider
    ?? projectDefaultProvider
    ?? null;

  const resolvedVmSize: VMSize = vmSize
    ?? (resolvedProfile?.vmSizeOverride as VMSize | null)
    ?? (project.defaultVmSize as VMSize | null)
    ?? DEFAULT_VM_SIZE;

  const resolvedVmLocation: VMLocation = (
    (resolvedProfile?.vmLocation as VMLocation | null)
    ?? (project.defaultLocation as VMLocation | null)
    ?? (resolvedProvider ? getDefaultLocationForProvider(resolvedProvider) as VMLocation | null : null)
    ?? DEFAULT_VM_LOCATION
  ) as VMLocation;

  const resolvedWorkspaceProfile: WorkspaceProfile = (input.workspaceProfile as WorkspaceProfile | undefined)
    ?? (resolvedProfile?.workspaceProfile as WorkspaceProfile | null)
    ?? (project.defaultWorkspaceProfile as WorkspaceProfile | null)
    ?? DEFAULT_WORKSPACE_PROFILE;

  const resolvedTaskMode: TaskMode = (input.taskMode as TaskMode | undefined)
    ?? (resolvedProfile?.taskMode as TaskMode | null)
    ?? (resolvedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task');

  const resolvedAgentType: string | null = input.agentType
    ?? resolvedProfile?.agentType
    ?? project.defaultAgentType
    ?? null;

  const checkoutBranch = input.branch?.trim() || project.defaultBranch;

  // Validate location against resolved provider
  if (resolvedProvider !== null && !isValidLocationForProvider(resolvedProvider, resolvedVmLocation)) {
    const validLocations = getLocationsForProvider(resolvedProvider).map((l) => l.id);
    return { error: `Location '${resolvedVmLocation}' is not valid for provider '${resolvedProvider}'. Valid: ${validLocations.join(', ')}` };
  }

  // ── Verify cloud credentials ──────────────────────────────────────────
  const { resolveCredentialSource } = await import('../../../services/provider-credentials');
  const credResult = await resolveCredentialSource(db, ctx.userId, resolvedProvider ?? undefined);
  if (!credResult) {
    return { error: 'No cloud provider credentials found. The user must connect a cloud provider in Settings.' };
  }

  // ── Generate title and branch name ────────────────────────────────────
  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = await generateTaskTitle(env.AI, description, titleConfig);

  const taskId = ulid();
  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(description, taskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  const now = new Date().toISOString();

  // ── Insert task ────────────────────────────────────────────────────────
  await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     task_mode, agent_profile_hint, mission_id,
     created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 'node_selection', ?, 0, ?, ?,
     ?, ?, ?,
     ?, ?)`,
  ).bind(
    taskId, input.projectId, ctx.userId,
    taskTitle, description, priority, branchName,
    ctx.userId,
    resolvedTaskMode, resolvedProfile?.profileId ?? null, input.missionId?.trim() || null,
    now, now,
  ).run();

  // Record status event: null -> queued
  const statusEventId = ulid();
  await env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status,
     actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', 'user', ?, ?, ?)`,
  ).bind(
    statusEventId, taskId, ctx.userId,
    'Dispatched via SAM',
    now,
  ).run();

  // ── Create chat session and persist initial message ──────────────────
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      env,
      input.projectId,
      null,
      taskTitle,
      taskId,
    );

    await projectDataService.persistMessage(
      env,
      input.projectId,
      sessionId,
      'user',
      description,
      null,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
    ).bind(`Session creation failed: ${errorMsg}`, new Date().toISOString(), taskId).run();
    log.error('sam.dispatch_task.session_failed', { taskId, projectId: input.projectId, error: errorMsg });
    return { error: `Failed to create chat session: ${errorMsg}` };
  }

  // ── Start TaskRunner DO ────────────────────────────────────────────────
  const [userRow] = await db
    .select({ name: schema.users.name, email: schema.users.email, githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId))
    .limit(1);

  try {
    await startTaskRunnerDO(env, {
      taskId,
      projectId: input.projectId,
      userId: ctx.userId,
      vmSize: resolvedVmSize,
      vmLocation: resolvedVmLocation,
      branch: checkoutBranch,
      userName: userRow?.name ?? null,
      userEmail: userRow?.email ?? null,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: description,
      repository: project.repository,
      installationId: project.installationId,
      outputBranch: branchName,
      projectDefaultVmSize: project.defaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType: resolvedAgentType,
      workspaceProfile: resolvedWorkspaceProfile,
      cloudProvider: resolvedProvider,
      taskMode: resolvedTaskMode,
      model:
        resolvedProfile?.model ??
        resolveProjectAgentDefault(project.agentDefaults, resolvedAgentType).model,
      permissionMode:
        resolvedProfile?.permissionMode ??
        resolveProjectAgentDefault(project.agentDefaults, resolvedAgentType).permissionMode,
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
    const errorMsg = err instanceof Error ? err.message : String(err);
    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
    ).bind(`Task runner startup failed: ${errorMsg}`, new Date().toISOString(), taskId).run();
    log.error('sam.dispatch_task.do_startup_failed', { taskId, projectId: input.projectId, error: errorMsg });
    return { error: `Failed to start task runner: ${errorMsg}` };
  }

  // ── Activity event (best-effort) ──────────────────────────────────────
  try {
    const doId = env.PROJECT_DATA.idFromName(input.projectId);
    const doStub = env.PROJECT_DATA.get(doId);
    await doStub.fetch(new Request('https://do/activity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'task.dispatched',
        actorType: 'user',
        actorId: ctx.userId,
        metadata: {
          taskId,
          title: taskTitle,
          branchName,
          source: 'sam',
        },
      }),
    }));
  } catch (err) {
    log.warn('sam.dispatch_task.activity_event_failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const appDomain = `app.${env.BASE_DOMAIN}`;
  const taskUrl = `https://${appDomain}/projects/${input.projectId}/ideas/${taskId}`;

  log.info('sam.dispatch_task.created', {
    taskId,
    sessionId,
    branchName,
    projectId: input.projectId,
    vmSize: resolvedVmSize,
    taskMode: resolvedTaskMode,
    agentType: resolvedAgentType,
  });

  return {
    taskId,
    sessionId,
    branchName,
    title: taskTitle,
    status: 'queued',
    url: taskUrl,
    message: `Task dispatched successfully. Track progress at: ${taskUrl}`,
  };
}
