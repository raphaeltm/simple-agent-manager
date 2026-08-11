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
  ProjectAgentDefaults,
  ProjectSummary,
  RepoProvider,
  Task,
  TaskDependency,
  TaskMode,
  TaskStatus,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_WORKSPACE_PROFILE,
  isTaskExecutionStep,
  parseCompletionEvidenceJson,
  VALID_PERMISSION_MODES,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

// Mirrors ProjectAgentDefaults (packages/shared/src/types/project.ts) and the
// write-time AgentDefaultEntrySchema (apps/api/src/schemas/projects.ts,
// unexported so it isn't reused directly): a record keyed by agent type, each
// entry optionally overriding model/permissionMode. Any row written through
// the PATCH route already satisfies this; the schema exists to stop a
// pre-validation legacy or hand-edited row from being blindly cast and handed
// to callers as if it were well-formed.
const agentDefaultEntrySchema = v.object({
  model: v.optional(v.nullable(v.string())),
  permissionMode: v.optional(v.nullable(v.picklist(VALID_PERMISSION_MODES))),
});
const projectAgentDefaultsSchema = v.record(v.string(), agentDefaultEntrySchema);

/**
 * Parse the project.agentDefaults JSON column. Returns null if unset or invalid.
 * We validate the *shape* (a record of agent-type -> { model?, permissionMode? }
 * objects); per-field content validation beyond that (e.g. the permission-mode
 * enum) mirrors the write-time schema so the inferred type lines up with
 * ProjectAgentDefaults, not an independent re-validation policy.
 */
function parseAgentDefaults(raw: string | null): ProjectAgentDefaults | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // v.record() alone accepts arrays (numeric indices satisfy string keys), so
  // the array rejection needs to stay explicit — matching the original
  // `!Array.isArray(parsed)` guard — rather than relying on the record schema.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const result = v.safeParse(projectAgentDefaultsSchema, parsed);
  return result.success ? result.output : null;
}

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
    workspaceProfile:
      (ws.workspaceProfile as WorkspaceResponse['workspaceProfile']) ?? DEFAULT_WORKSPACE_PROFILE,
    devcontainerConfigName: ws.devcontainerConfigName ?? null,
    vmIp: ws.vmIp,
    lastActivityAt: ws.lastActivityAt,
    portsPublicEnabled: ws.portsPublicEnabled,
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
    repoProvider: (project.repoProvider as RepoProvider) || 'github',
    artifactsRepoId: project.artifactsRepoId ?? null,
    defaultVmSize: (project.defaultVmSize as Project['defaultVmSize']) ?? null,
    defaultAgentType: project.defaultAgentType ?? null,
    defaultWorkspaceProfile:
      (project.defaultWorkspaceProfile as Project['defaultWorkspaceProfile']) ?? null,
    defaultDevcontainerConfigName: project.defaultDevcontainerConfigName ?? null,
    defaultProvider: (project.defaultProvider as Project['defaultProvider']) ?? null,
    defaultLocation: project.defaultLocation ?? null,
    agentDefaults: parseAgentDefaults(project.agentDefaults),
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
    repoProvider: (project.repoProvider as RepoProvider) || 'github',
    status: (project.status as 'active' | 'detached') || 'active',
    activeWorkspaceCount,
    activeSessionCount: project.activeSessionCount ?? 0,
    lastActivityAt: project.lastActivityAt ?? null,
    createdAt: project.createdAt,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  };
}

export function toTaskResponse(
  task: schema.Task,
  blocked = false,
  displayAgentProfileHint = task.agentProfileHint
): Task {
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
    agentProfileHint: displayAgentProfileHint,
    skillId: task.skillId ?? null,
    skillHint: task.skillHint ?? null,
    blocked,
    triggeredBy: task.triggeredBy ?? 'user',
    triggerId: task.triggerId ?? null,
    triggerExecutionId: task.triggerExecutionId ?? null,
    requestedVmSize: task.requestedVmSize ?? null,
    requestedVmSizeSource: (task.requestedVmSizeSource as Task['requestedVmSizeSource']) ?? null,
    provisionedVmSize: task.provisionedVmSize ?? null,
    resourceRequirementsJson: task.resourceRequirementsJson ?? null,
    resourceRequirementsSource:
      (task.resourceRequirementsSource as Task['resourceRequirementsSource']) ?? null,
    resolvedReservationJson: task.resolvedReservationJson ?? null,
    placementExplanationJson: task.placementExplanationJson ?? null,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    errorMessage: task.errorMessage,
    outputSummary: task.outputSummary,
    outputBranch: task.outputBranch,
    outputPrUrl: task.outputPrUrl,
    completionEvidence: parseCompletionEvidenceJson(task.completionEvidence ?? null),
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
