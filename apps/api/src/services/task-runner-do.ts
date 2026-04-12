/**
 * TaskRunner DO Service — helper functions for Worker routes to interact
 * with the TaskRunner Durable Object.
 *
 * This is the bridge between HTTP routes and the DO. Routes should call
 * these functions instead of accessing the DO binding directly.
 */
import type { CredentialProvider, TaskAttachment,TaskMode, VMLocation, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';

import type { StartTaskInput, TaskRunner } from '../durable-objects/task-runner';
import type { Env } from '../index';
import { log } from '../lib/logger';

/**
 * Get a typed DO stub for the given task.
 * Uses `idFromName(taskId)` for deterministic mapping — one DO per task.
 */
function getStub(env: Env, taskId: string): DurableObjectStub<TaskRunner> {
  const id = env.TASK_RUNNER.idFromName(taskId);
  return env.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>;
}

/**
 * Start a TaskRunner DO for the given task.
 * Called from task-submit and task-runs routes after creating the task in D1.
 */
export async function startTaskRunnerDO(
  env: Env,
  input: {
    taskId: string;
    projectId: string;
    userId: string;
    vmSize: VMSize;
    vmLocation: VMLocation;
    branch: string;
    preferredNodeId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    githubId?: string | null;
    taskTitle: string;
    taskDescription?: string | null;
    repository: string;
    installationId: string;
    outputBranch?: string | null;
    projectDefaultVmSize?: VMSize | null;
    /** Chat session ID created at task submit time (TDF-6) */
    chatSessionId?: string | null;
    /** Agent type to use (e.g., 'claude-code', 'openai-codex') */
    agentType?: string | null;
    /** Workspace provisioning profile. 'lightweight' skips devcontainer build. */
    workspaceProfile?: WorkspaceProfile | null;
    /** Devcontainer config name (subdirectory under .devcontainer/). Null = auto-discover. */
    devcontainerConfigName?: string | null;
    /** Cloud provider for auto-provisioned nodes. Falls back to any available credential. */
    cloudProvider?: CredentialProvider | null;
    /** Task execution mode. 'task' = push/PR/complete. 'conversation' = human-controlled. */
    taskMode?: TaskMode;
    /** Model override from agent profile. Null = use agent default. */
    model?: string | null;
    /** Permission mode override from agent profile. Null = use agent default. */
    permissionMode?: string | null;
    /** System prompt text to append to the initial prompt (from agent profile). */
    systemPromptAppend?: string | null;
    /** File attachments uploaded to R2 before task submission. */
    attachments?: TaskAttachment[] | null;
    /** Per-project scaling overrides. */
    projectScaling?: {
      taskExecutionTimeoutMs?: number | null;
      maxWorkspacesPerNode?: number | null;
      nodeCpuThresholdPercent?: number | null;
      nodeMemoryThresholdPercent?: number | null;
      warmNodeTimeoutMs?: number | null;
    } | null;
  },
): Promise<void> {
  const stub = getStub(env, input.taskId);

  const startInput: StartTaskInput = {
    taskId: input.taskId,
    projectId: input.projectId,
    userId: input.userId,
    config: {
      vmSize: input.vmSize,
      vmLocation: input.vmLocation,
      branch: input.branch,
      preferredNodeId: input.preferredNodeId ?? null,
      userName: input.userName ?? null,
      userEmail: input.userEmail ?? null,
      githubId: input.githubId ?? null,
      taskTitle: input.taskTitle,
      taskDescription: input.taskDescription ?? null,
      repository: input.repository,
      installationId: input.installationId,
      outputBranch: input.outputBranch ?? null,
      projectDefaultVmSize: input.projectDefaultVmSize ?? null,
      chatSessionId: input.chatSessionId ?? null,
      agentType: input.agentType ?? null,
      workspaceProfile: input.workspaceProfile ?? null,
      devcontainerConfigName: input.devcontainerConfigName ?? null,
      cloudProvider: input.cloudProvider ?? null,
      taskMode: input.taskMode ?? 'task',
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? null,
      systemPromptAppend: input.systemPromptAppend ?? null,
      attachments: input.attachments ?? null,
      projectScaling: input.projectScaling ?? null,
    },
  };

  await stub.start(startInput);

  log.info('task_runner_do_service.started', {
    taskId: input.taskId,
    projectId: input.projectId,
  });
}

/**
 * Notify the TaskRunner DO that a workspace is ready (or has errored).
 * Called from the workspace ready callback route.
 */
export async function advanceTaskRunnerWorkspaceReady(
  env: Env,
  taskId: string,
  status: 'running' | 'recovery' | 'error',
  errorMessage: string | null,
): Promise<void> {
  const stub = getStub(env, taskId);

  await stub.advanceWorkspaceReady(status, errorMessage);

  log.info('task_runner_do_service.workspace_ready_advanced', {
    taskId,
    status,
  });
}

/**
 * Get the current state of a TaskRunner DO (for debugging).
 */
export async function getTaskRunnerStatus(
  env: Env,
  taskId: string,
): Promise<unknown> {
  const stub = getStub(env, taskId);

  return stub.getStatus();
}
