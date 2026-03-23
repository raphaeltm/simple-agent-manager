import type {
  CreateProjectRequest,
  ListProjectsResponse,
  Project,
  ProjectDetailResponse,
  ProjectRuntimeConfigResponse,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
  UpdateProjectRequest,
  DashboardActiveTasksResponse,
} from '@simple-agent-manager/shared';
import { request } from './client';

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

// =============================================================================
// Activity Events
// =============================================================================

export interface ActivityEventResponse {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface ActivityEventsListResponse {
  events: ActivityEventResponse[];
  hasMore: boolean;
}

export async function listActivityEvents(
  projectId: string,
  params?: { eventType?: string; before?: number; limit?: number }
): Promise<ActivityEventsListResponse> {
  const searchParams = new URLSearchParams();
  if (params?.eventType) searchParams.set('eventType', params.eventType);
  if (params?.before) searchParams.set('before', String(params.before));
  if (params?.limit) searchParams.set('limit', String(params.limit));

  const qs = searchParams.toString();
  const endpoint = `/api/projects/${projectId}/activity${qs ? `?${qs}` : ''}`;
  return request<ActivityEventsListResponse>(endpoint);
}
