import type {
  CreateTaskRequest,
  CreateTaskDependencyRequest,
  DelegateTaskRequest,
  RunTaskRequest,
  RunTaskResponse,
  ListTaskEventsResponse,
  ListTasksResponse,
  Task,
  TaskDependency,
  TaskDetailResponse,
  TaskSortOrder,
  TaskStatus,
  UpdateTaskRequest,
  UpdateTaskStatusRequest,
} from '@simple-agent-manager/shared';
import { request } from './client';

// =============================================================================
// Task Submit (single-action chat flow)
// =============================================================================
export interface SubmitTaskRequest {
  message: string;
  vmSize?: string;
  vmLocation?: string;
  nodeId?: string;
  agentType?: string;
  workspaceProfile?: 'full' | 'lightweight';
  parentTaskId?: string;
  contextSummary?: string;
  taskMode?: 'task' | 'conversation';
}

export interface SubmitTaskResponse {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: 'queued';
}

export async function submitTask(
  projectId: string,
  data: SubmitTaskRequest
): Promise<SubmitTaskResponse> {
  return request<SubmitTaskResponse>(`/api/projects/${projectId}/tasks/submit`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function closeConversationTask(
  projectId: string,
  taskId: string,
): Promise<{ status: string; closedAt: string }> {
  return request<{ status: string; closedAt: string }>(`/api/projects/${projectId}/tasks/${taskId}/close`, {
    method: 'POST',
  });
}

// =============================================================================
// Tasks (CRUD)
// =============================================================================
export interface ListProjectTasksParams {
  status?: TaskStatus;
  minPriority?: number;
  sort?: TaskSortOrder;
  limit?: number;
  cursor?: string;
}

export async function listProjectTasks(
  projectId: string,
  params: ListProjectTasksParams = {}
): Promise<ListTasksResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) {
    searchParams.set('status', params.status);
  }
  if (params.minPriority !== undefined) {
    searchParams.set('minPriority', String(params.minPriority));
  }
  if (params.sort) {
    searchParams.set('sort', params.sort);
  }
  if (params.limit !== undefined) {
    searchParams.set('limit', String(params.limit));
  }
  if (params.cursor) {
    searchParams.set('cursor', params.cursor);
  }

  const query = searchParams.toString();
  const endpoint = query
    ? `/api/projects/${projectId}/tasks?${query}`
    : `/api/projects/${projectId}/tasks`;

  return request<ListTasksResponse>(endpoint);
}

export async function createProjectTask(
  projectId: string,
  data: CreateTaskRequest
): Promise<Task> {
  return request<Task>(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getProjectTask(
  projectId: string,
  taskId: string
): Promise<TaskDetailResponse> {
  return request<TaskDetailResponse>(`/api/projects/${projectId}/tasks/${taskId}`);
}

export async function updateProjectTask(
  projectId: string,
  taskId: string,
  data: UpdateTaskRequest
): Promise<Task> {
  return request<Task>(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteProjectTask(
  projectId: string,
  taskId: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/projects/${projectId}/tasks/${taskId}`, {
    method: 'DELETE',
  });
}

export async function updateProjectTaskStatus(
  projectId: string,
  taskId: string,
  data: UpdateTaskStatusRequest
): Promise<Task> {
  return request<Task>(`/api/projects/${projectId}/tasks/${taskId}/status`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function addTaskDependency(
  projectId: string,
  taskId: string,
  data: CreateTaskDependencyRequest
): Promise<TaskDependency> {
  return request<TaskDependency>(`/api/projects/${projectId}/tasks/${taskId}/dependencies`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeTaskDependency(
  projectId: string,
  taskId: string,
  dependsOnTaskId: string
): Promise<{ success: boolean }> {
  const query = new URLSearchParams({ dependsOnTaskId });
  return request<{ success: boolean }>(
    `/api/projects/${projectId}/tasks/${taskId}/dependencies?${query.toString()}`,
    {
      method: 'DELETE',
    }
  );
}

export async function delegateTask(
  projectId: string,
  taskId: string,
  data: DelegateTaskRequest
): Promise<Task> {
  return request<Task>(`/api/projects/${projectId}/tasks/${taskId}/delegate`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function runProjectTask(
  projectId: string,
  taskId: string,
  data: RunTaskRequest = {}
): Promise<RunTaskResponse> {
  return request<RunTaskResponse>(`/api/projects/${projectId}/tasks/${taskId}/run`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listTaskEvents(
  projectId: string,
  taskId: string,
  limit?: number
): Promise<ListTaskEventsResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) {
    params.set('limit', String(limit));
  }

  const endpoint = params.toString()
    ? `/api/projects/${projectId}/tasks/${taskId}/events?${params.toString()}`
    : `/api/projects/${projectId}/tasks/${taskId}/events`;

  return request<ListTaskEventsResponse>(endpoint);
}

export interface TaskSessionLink {
  sessionId: string;
  topic: string | null;
  status: string;
  context: string | null;
  linkedAt: number;
}

export interface TaskSessionsResponse {
  sessions: TaskSessionLink[];
  count: number;
}

export async function getTaskSessions(
  projectId: string,
  taskId: string
): Promise<TaskSessionsResponse> {
  return request<TaskSessionsResponse>(`/api/projects/${projectId}/tasks/${taskId}/sessions`);
}
