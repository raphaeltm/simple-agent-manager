/**
 * SAM retry_subtask tool — retry a failed or cancelled task.
 *
 * Creates a new task with the same description and project, then starts
 * the task runner. The original task is left unchanged for history.
 */
import {
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  isValidProvider,
  type TaskMode,
  type VMSize,
  type WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../../db/schema';
import type { Env } from '../../../env';
import { log } from '../../../lib/logger';
import { ulid } from '../../../lib/ulid';
import { generateBranchName } from '../../../services/branch-name';
import { resolveProjectAgentDefault } from '../../../services/project-agent-defaults';
import * as projectDataService from '../../../services/project-data';
import { startTaskRunnerDO } from '../../../services/task-runner-do';
import { generateTaskTitle, getTaskTitleConfig } from '../../../services/task-title';
import type { AnthropicToolDef, ToolContext } from '../types';

const RETRYABLE_STATUSES = ['failed', 'cancelled'];

export const retrySubtaskDef: AnthropicToolDef = {
  name: 'retry_subtask',
  description:
    'Retry a failed or cancelled task by creating a new task with the same description. ' +
    'Optionally provide a new description to adjust the instructions. ' +
    'The original task is preserved for history.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the failed/cancelled task to retry.',
      },
      newDescription: {
        type: 'string',
        description: 'Optional new description. If omitted, reuses the original task description.',
      },
    },
    required: ['taskId'],
  },
};

export async function retrySubtask(
  input: { taskId: string; newDescription?: string },
  ctx: ToolContext,
): Promise<unknown> {
  if (!input.taskId?.trim()) {
    return { error: 'taskId is required.' };
  }

  const env = ctx.env as unknown as Env;
  const db = drizzle(env.DATABASE, { schema });
  const taskId = input.taskId.trim();

  // Look up original task with ownership verification
  const rows = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      description: schema.tasks.description,
      projectId: schema.tasks.projectId,
      missionId: schema.tasks.missionId,
      taskMode: schema.tasks.taskMode,
      agentProfileHint: schema.tasks.agentProfileHint,
      projectName: schema.projects.name,
      projectRepository: schema.projects.repository,
      projectInstallationId: schema.projects.installationId,
      projectDefaultBranch: schema.projects.defaultBranch,
      projectDefaultVmSize: schema.projects.defaultVmSize,
      projectDefaultProvider: schema.projects.defaultProvider,
      projectDefaultLocation: schema.projects.defaultLocation,
      projectDefaultWorkspaceProfile: schema.projects.defaultWorkspaceProfile,
      projectDefaultAgentType: schema.projects.defaultAgentType,
      projectAgentDefaults: schema.projects.agentDefaults,
      projectTaskExecutionTimeoutMs: schema.projects.taskExecutionTimeoutMs,
      projectMaxWorkspacesPerNode: schema.projects.maxWorkspacesPerNode,
      projectNodeCpuThresholdPercent: schema.projects.nodeCpuThresholdPercent,
      projectNodeMemoryThresholdPercent: schema.projects.nodeMemoryThresholdPercent,
      projectWarmNodeTimeoutMs: schema.projects.warmNodeTimeoutMs,
    })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.tasks.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.tasks.id, taskId),
        eq(schema.projects.userId, ctx.userId),
      ),
    )
    .limit(1);

  const original = rows[0];
  if (!original) {
    return { error: 'Task not found or not owned by you.' };
  }

  if (!RETRYABLE_STATUSES.includes(original.status)) {
    return { error: `Task is in '${original.status}' status — only failed or cancelled tasks can be retried.` };
  }

  // Use new description or fall back to original
  const description = input.newDescription?.trim() || original.description;
  if (!description) {
    return { error: 'Task has no description and no newDescription was provided.' };
  }

  // Resolve config from project defaults
  const resolvedProvider =
    typeof original.projectDefaultProvider === 'string' && isValidProvider(original.projectDefaultProvider)
      ? original.projectDefaultProvider
      : null;

  const resolvedVmSize: VMSize = (original.projectDefaultVmSize as VMSize | null) ?? DEFAULT_VM_SIZE;

  const resolvedVmLocation =
    (original.projectDefaultLocation as string | null)
    ?? (resolvedProvider ? getDefaultLocationForProvider(resolvedProvider) : null)
    ?? DEFAULT_VM_LOCATION;

  const resolvedWorkspaceProfile: WorkspaceProfile =
    (original.projectDefaultWorkspaceProfile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE;

  const resolvedTaskMode = (original.taskMode as TaskMode | null) ?? (resolvedWorkspaceProfile === 'lightweight' ? 'conversation' : 'task');
  const resolvedAgentType = original.projectDefaultAgentType ?? null;

  // Verify cloud credentials
  const { resolveCredentialSource } = await import('../../../services/provider-credentials');
  const credResult = await resolveCredentialSource(db, ctx.userId, resolvedProvider ?? undefined);
  if (!credResult) {
    return { error: 'No cloud provider credentials found. The user must connect a cloud provider in Settings.' };
  }

  // Generate new task
  const newTaskId = ulid();
  const titleConfig = getTaskTitleConfig(env);
  const taskTitle = await generateTaskTitle(env.AI, description, titleConfig);

  const branchPrefix = env.BRANCH_NAME_PREFIX || 'sam/';
  const branchMaxLength = parseInt(env.BRANCH_NAME_MAX_LENGTH || '60', 10);
  const branchName = generateBranchName(description, newTaskId, {
    prefix: branchPrefix,
    maxLength: branchMaxLength,
  });

  const now = new Date().toISOString();

  // Insert new task
  await env.DATABASE.prepare(
    `INSERT INTO tasks (id, project_id, user_id, title, description,
     status, execution_step, priority, dispatch_depth, output_branch, created_by,
     task_mode, agent_profile_hint, mission_id,
     created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 'node_selection', 0, 0, ?, ?,
     ?, ?, ?,
     ?, ?)`,
  ).bind(
    newTaskId, original.projectId, ctx.userId,
    taskTitle, description, 0, branchName,
    ctx.userId,
    resolvedTaskMode, original.agentProfileHint ?? null, original.missionId ?? null,
    now, now,
  ).run();

  // Record status event
  await env.DATABASE.prepare(
    `INSERT INTO task_status_events (id, task_id, from_status, to_status,
     actor_type, actor_id, reason, created_at)
     VALUES (?, ?, NULL, 'queued', 'user', ?, ?, ?)`,
  ).bind(ulid(), newTaskId, ctx.userId, `Retry of task ${taskId} via SAM`, now).run();

  // Create chat session
  let sessionId: string;
  try {
    sessionId = await projectDataService.createSession(
      env, original.projectId, null, taskTitle, newTaskId,
    );
    await projectDataService.persistMessage(
      env, original.projectId, sessionId, 'user', description, null,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
    ).bind(`Session creation failed: ${errorMsg}`, new Date().toISOString(), newTaskId).run();
    return { error: `Failed to create chat session: ${errorMsg}` };
  }

  // Start TaskRunner DO
  const [userRow] = await db
    .select({ name: schema.users.name, email: schema.users.email, githubId: schema.users.githubId })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId))
    .limit(1);

  const agentDefaults = resolveProjectAgentDefault(
    original.projectAgentDefaults as string | null,
    resolvedAgentType,
  );

  try {
    await startTaskRunnerDO(env, {
      taskId: newTaskId,
      projectId: original.projectId,
      userId: ctx.userId,
      vmSize: resolvedVmSize,
      vmLocation: resolvedVmLocation,
      branch: original.projectDefaultBranch,
      userName: userRow?.name ?? null,
      userEmail: userRow?.email ?? null,
      githubId: userRow?.githubId ?? null,
      taskTitle,
      taskDescription: description,
      repository: original.projectRepository,
      installationId: original.projectInstallationId,
      outputBranch: branchName,
      projectDefaultVmSize: original.projectDefaultVmSize as VMSize | null,
      chatSessionId: sessionId,
      agentType: resolvedAgentType,
      workspaceProfile: resolvedWorkspaceProfile,
      cloudProvider: resolvedProvider,
      taskMode: resolvedTaskMode,
      model: agentDefaults.model,
      permissionMode: agentDefaults.permissionMode,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      projectScaling: {
        taskExecutionTimeoutMs: original.projectTaskExecutionTimeoutMs ?? null,
        maxWorkspacesPerNode: original.projectMaxWorkspacesPerNode ?? null,
        nodeCpuThresholdPercent: original.projectNodeCpuThresholdPercent ?? null,
        nodeMemoryThresholdPercent: original.projectNodeMemoryThresholdPercent ?? null,
        warmNodeTimeoutMs: original.projectWarmNodeTimeoutMs ?? null,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
    ).bind(`Task runner startup failed: ${errorMsg}`, new Date().toISOString(), newTaskId).run();
    return { error: `Failed to start task runner: ${errorMsg}` };
  }

  const appDomain = `app.${env.BASE_DOMAIN}`;
  const taskUrl = `https://${appDomain}/projects/${original.projectId}/ideas/${newTaskId}`;

  log.info('sam.retry_subtask.created', {
    originalTaskId: taskId,
    newTaskId,
    projectId: original.projectId,
  });

  return {
    newTaskId,
    originalTaskId: taskId,
    sessionId,
    branchName,
    title: taskTitle,
    status: 'queued',
    url: taskUrl,
    message: `Retry task created. Track progress at: ${taskUrl}`,
  };
}
