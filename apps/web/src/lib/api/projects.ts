import type {
  CreateProjectRequest,
  DashboardActiveTasksResponse,
  ListProjectsResponse,
  Project,
  ProjectDetailResponse,
  ProjectRuntimeConfigResponse,
  UpdateProjectRequest,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
} from '@simple-agent-manager/shared';

import { request } from './client';

// =============================================================================
// Account Map
// =============================================================================

export interface AccountMapResponse {
  projects: Array<{
    id: string;
    name: string;
    repository: string | null;
    status: string | null;
    lastActivityAt: string | null;
    activeSessionCount: number | null;
  }>;
  nodes: Array<{
    id: string;
    name: string;
    status: string;
    vmSize: string | null;
    vmLocation: string | null;
    cloudProvider: string | null;
    ipAddress: string | null;
    healthStatus: string | null;
    lastHeartbeatAt: string | null;
    lastMetrics: string | null;
  }>;
  workspaces: Array<{
    id: string;
    nodeId: string | null;
    projectId: string | null;
    displayName: string | null;
    branch: string | null;
    status: string;
    vmSize: string | null;
    chatSessionId: string | null;
  }>;
  sessions: Array<{
    id: string;
    projectId: string;
    topic: string | null;
    status: string;
    messageCount: number;
    workspaceId: string | null;
    taskId: string | null;
  }>;
  tasks: Array<{
    id: string;
    projectId: string | null;
    workspaceId: string | null;
    title: string;
    status: string;
    executionStep: string | null;
    priority: number | null;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    type: string;
    active: boolean;
  }>;
}

export async function getAccountMap(options?: { activeOnly?: boolean }): Promise<AccountMapResponse> {
  const params = new URLSearchParams();
  if (options?.activeOnly === false) {
    params.set('activeOnly', 'false');
  }
  const qs = params.toString();
  return request<AccountMapResponse>(`/api/account-map${qs ? `?${qs}` : ''}`);
}

// =============================================================================
// Dashboard
// =============================================================================

export async function listActiveTasks(): Promise<DashboardActiveTasksResponse> {
  return request<DashboardActiveTasksResponse>('/api/dashboard/active-tasks');
}

// =============================================================================
// Projects
// =============================================================================

export async function listProjects(limit?: number, cursor?: string): Promise<ListProjectsResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }
  if (cursor) {
    params.set('cursor', cursor);
  }

  const url = params.toString() ? `/api/projects?${params.toString()}` : '/api/projects';
  return request<ListProjectsResponse>(url);
}

export async function createProject(data: CreateProjectRequest): Promise<Project> {
  return request<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getProject(id: string): Promise<ProjectDetailResponse> {
  return request<ProjectDetailResponse>(`/api/projects/${id}`);
}

export async function updateProject(id: string, data: UpdateProjectRequest): Promise<Project> {
  return request<Project>(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/projects/${id}`, {
    method: 'DELETE',
  });
}

export async function getProjectRuntimeConfig(
  projectId: string
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(`/api/projects/${projectId}/runtime-config`);
}

export async function upsertProjectRuntimeEnvVar(
  projectId: string,
  data: UpsertProjectRuntimeEnvVarRequest
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(`/api/projects/${projectId}/runtime/env-vars`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteProjectRuntimeEnvVar(
  projectId: string,
  envKey: string
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/runtime/env-vars/${encodeURIComponent(envKey)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function upsertProjectRuntimeFile(
  projectId: string,
  data: UpsertProjectRuntimeFileRequest
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(`/api/projects/${projectId}/runtime/files`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteProjectRuntimeFile(
  projectId: string,
  path: string
): Promise<ProjectRuntimeConfigResponse> {
  const params = new URLSearchParams({ path });
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/runtime/files?${params.toString()}`,
    {
      method: 'DELETE',
    }
  );
}
