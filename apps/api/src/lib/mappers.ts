/**
 * Response mappers — convert database schema types to API response DTOs.
 *
 * Centralizes mappers that were previously defined inline in each route file:
 * - toWorkspaceResponse (was in workspaces.ts)
 * - toAgentSessionResponse (was in workspaces.ts)
 * - toProjectResponse, toProjectSummaryResponse (was in projects.ts)
 * - toTaskResponse, toDependencyResponse (was in tasks.ts)
 */

import type {
  AgentSession,
  Project,
  ProjectSummary,
  Task,
  TaskDependency,
  TaskMode,
  TaskStatus,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import { DEFAULT_WORKSPACE_PROFILE,isTaskExecutionStep } from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';
import { getWorkspaceUrl } from '../services/dns';

export function toWorkspaceResponse(ws: schema.Workspace, baseDomain: string): WorkspaceResponse {
  return {
    id: ws.id,
    nodeId: ws.nodeId ?? undefined,
    projectId: ws.projectId,
    displayName: ws.displayName ?? ws.name,
    name: ws.name,
    repository: ws.repository,
    branch: ws.branch,
    status: ws.status as WorkspaceResponse['status'],
    vmSize: ws.vmSize as WorkspaceResponse['vmSize'],
    vmLocation: ws.vmLocation as WorkspaceResponse['vmLocation'],
    workspaceProfile: (ws.workspaceProfile as WorkspaceResponse['workspaceProfile']) ?? DEFAULT_WORKSPACE_PROFILE,
    vmIp: ws.vmIp,
    lastActivityAt: ws.lastActivityAt,
    errorMessage: ws.errorMessage,
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
    url: getWorkspaceUrl(ws.id, baseDomain),
    chatSessionId: ws.chatSessionId ?? null,
  };
}

export function toAgentSessionResponse(session: schema.AgentSession): AgentSession {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    status: session.status as AgentSession['status'],
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stoppedAt: session.stoppedAt,
    suspendedAt: session.suspendedAt,
    errorMessage: session.errorMessage,
    label: session.label,
    agentType: session.agentType,
    worktreePath: session.worktreePath,
    lastPrompt: session.lastPrompt,
  };
}

export function toProjectResponse(project: schema.Project): Project {
  return {
    id: project.id,
    userId: project.userId,
    name: project.name,
    description: project.description,
    installationId: project.installationId,
    repository: project.repository,
    defaultBranch: project.defaultBranch,
    defaultVmSize: (project.defaultVmSize as Project['defaultVmSize']) ?? null,
    defaultAgentType: project.defaultAgentType ?? null,
    defaultWorkspaceProfile: (project.defaultWorkspaceProfile as Project['defaultWorkspaceProfile']) ?? null,
    defaultProvider: (project.defaultProvider as Project['defaultProvider']) ?? null,
    defaultLocation: project.defaultLocation ?? null,
    workspaceIdleTimeoutMs: project.workspaceIdleTimeoutMs ?? null,
    nodeIdleTimeoutMs: project.nodeIdleTimeoutMs ?? null,
    taskExecutionTimeoutMs: project.taskExecutionTimeoutMs ?? null,
    maxConcurrentTasks: project.maxConcurrentTasks ?? null,
    maxDispatchDepth: project.maxDispatchDepth ?? null,
    maxSubTasksPerTask: project.maxSubTasksPerTask ?? null,
    warmNodeTimeoutMs: project.warmNodeTimeoutMs ?? null,
    maxWorkspacesPerNode: project.maxWorkspacesPerNode ?? null,
    nodeCpuThresholdPercent: project.nodeCpuThresholdPercent ?? null,
    nodeMemoryThresholdPercent: project.nodeMemoryThresholdPercent ?? null,
    status: (project.status as 'active' | 'detached') || 'active',
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function toProjectSummaryResponse(
  project: schema.Project,
  activeWorkspaceCount: number
): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    repository: project.repository,
    githubRepoId: project.githubRepoId,
    defaultBranch: project.defaultBranch,
    status: (project.status as 'active' | 'detached') || 'active',
    activeWorkspaceCount,
    activeSessionCount: project.activeSessionCount ?? 0,
    lastActivityAt: project.lastActivityAt ?? null,
    createdAt: project.createdAt,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  };
}

export function toTaskResponse(task: schema.Task, blocked = false): Task {
  return {
    id: task.id,
    projectId: task.projectId,
    userId: task.userId,
    parentTaskId: task.parentTaskId,
    workspaceId: task.workspaceId,
    title: task.title,
    description: task.description,
    status: task.status as TaskStatus,
    executionStep: isTaskExecutionStep(task.executionStep) ? task.executionStep : null,
    priority: task.priority,
    taskMode: (task.taskMode as TaskMode) || 'task',
    dispatchDepth: task.dispatchDepth,
    agentProfileHint: task.agentProfileHint,
    blocked,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    errorMessage: task.errorMessage,
    outputSummary: task.outputSummary,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    finalizedAt: task.finalizedAt ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function toDependencyResponse(dependency: schema.TaskDependency): TaskDependency {
  return {
    taskId: dependency.taskId,
    dependsOnTaskId: dependency.dependsOnTaskId,
    createdAt: dependency.createdAt,
  };
}
