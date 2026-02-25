import type {
  User,
  NodeResponse,
  CreateNodeRequest,
  CreateProjectRequest,
  CreateTaskDependencyRequest,
  CreateTaskRequest,
  WorkspaceResponse,
  CreateWorkspaceRequest,
  DelegateTaskRequest,
  RunTaskRequest,
  RunTaskResponse,
  ListProjectsResponse,
  ListTaskEventsResponse,
  ListTasksResponse,
  Project,
  ProjectDetailResponse,
  ProjectRuntimeConfigResponse,
  Task,
  TaskDependency,
  TaskDetailResponse,
  TaskSortOrder,
  TaskStatus,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
  UpdateProjectRequest,
  UpdateTaskRequest,
  UpdateTaskStatusRequest,
  UpdateWorkspaceRequest,
  CredentialResponse,
  CreateCredentialRequest,
  GitHubInstallation,
  Repository,
  TerminalTokenResponse,
  AgentSession,
  CreateAgentSessionRequest,
  Event,
  ApiError,
  AgentInfo,
  AgentCredentialInfo,
  SaveAgentCredentialRequest,
  WorkspaceTab,
  WorktreeInfo,
  WorktreeListResponse,
  CreateWorktreeRequest,
  RemoveWorktreeResponse,
  GitBranchListResponse,
  AgentSettingsResponse,
  SaveAgentSettingsRequest,
  NodeSystemInfo,
  NodeLogFilter,
  NodeLogResponse,
  AdminUsersResponse,
  UserRole,
  UserStatus,
  ErrorListResponse,
  HealthSummary,
  ErrorTrendResponse,
  LogQueryResponse,
} from '@simple-agent-manager/shared';

// In production, VITE_API_URL must be explicitly set
const API_URL = (() => {
  const url = import.meta.env.VITE_API_URL;
  if (!url && import.meta.env.PROD) {
    throw new Error('VITE_API_URL is required in production builds');
  }
  return url || 'http://localhost:8787';
})();

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    credentials: 'include', // Include cookies for session auth
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle non-JSON responses
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    if (!response.ok) {
      throw new ApiClientError(
        'UNKNOWN_ERROR',
        'Server returned non-JSON response',
        response.status
      );
    }
    return {} as T;
  }

  const data = await response.json();

  if (!response.ok) {
    const error = data as ApiError;
    throw new ApiClientError(error.error, error.message, response.status);
  }

  return data as T;
}

// =============================================================================
// Auth
// =============================================================================
export async function getCurrentUser(): Promise<User> {
  return request<User>('/api/auth/me');
}

// =============================================================================
// Credentials
// =============================================================================
export async function listCredentials(): Promise<CredentialResponse[]> {
  return request<CredentialResponse[]>('/api/credentials');
}

export async function createCredential(data: CreateCredentialRequest): Promise<CredentialResponse> {
  return request<CredentialResponse>('/api/credentials', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteCredential(provider: string): Promise<void> {
  return request<void>(`/api/credentials/${provider}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// GitHub
// =============================================================================
export async function listGitHubInstallations(): Promise<GitHubInstallation[]> {
  return request<GitHubInstallation[]>('/api/github/installations');
}

export async function getGitHubInstallUrl(): Promise<{ url: string }> {
  return request<{ url: string }>('/api/github/install-url');
}

export async function listRepositories(installationId?: string): Promise<Repository[]> {
  const url = installationId
    ? `/api/github/repositories?installation_id=${installationId}`
    : '/api/github/repositories';
  return request<Repository[]>(url);
}

export async function listBranches(
  repository: string,
  installationId?: string,
  defaultBranch?: string
): Promise<Array<{ name: string }>> {
  const params = new URLSearchParams({ repository });
  if (installationId) {
    params.set('installation_id', installationId);
  }
  if (defaultBranch) {
    params.set('default_branch', defaultBranch);
  }
  return request<Array<{ name: string }>>(`/api/github/branches?${params.toString()}`);
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
// Tasks
// =============================================================================
export interface ListProjectTasksParams {
  status?: TaskStatus;
  minPriority?: number;
  sort?: TaskSortOrder;
  limit?: number;
  cursor?: string;
}

// =============================================================================
// Task Submit (single-action chat flow)
// =============================================================================
export interface SubmitTaskRequest {
  message: string;
  vmSize?: string;
  vmLocation?: string;
  nodeId?: string;
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

// =============================================================================
// Tasks (CRUD)
// =============================================================================
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

// =============================================================================
// Chat Sessions (Project DO)
// =============================================================================

export interface ChatSessionListResponse {
  sessions: ChatSessionResponse[];
  total: number;
}

export interface ChatSessionResponse {
  id: string;
  workspaceId: string | null;
  topic: string | null;
  status: string;
  messageCount: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
}

export interface ChatMessageResponse {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ChatSessionDetailResponse {
  session: ChatSessionResponse;
  messages: ChatMessageResponse[];
  hasMore: boolean;
}

export async function listChatSessions(
  projectId: string,
  params: { status?: string; limit?: number; offset?: number } = {}
): Promise<ChatSessionListResponse> {
  const searchParams = new URLSearchParams();
  if (params.status) searchParams.set('status', params.status);
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions?${qs}`
    : `/api/projects/${projectId}/sessions`;

  return request<ChatSessionListResponse>(endpoint);
}

export async function getChatSession(
  projectId: string,
  sessionId: string,
  params: { limit?: number; before?: number } = {}
): Promise<ChatSessionDetailResponse> {
  const searchParams = new URLSearchParams();
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.before !== undefined) searchParams.set('before', String(params.before));

  const qs = searchParams.toString();
  const endpoint = qs
    ? `/api/projects/${projectId}/sessions/${sessionId}?${qs}`
    : `/api/projects/${projectId}/sessions/${sessionId}`;

  return request<ChatSessionDetailResponse>(endpoint);
}

export async function createChatSession(
  projectId: string,
  data: { workspaceId?: string; topic?: string } = {}
): Promise<{ id: string }> {
  return request<{ id: string }>(`/api/projects/${projectId}/sessions`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function stopChatSession(
  projectId: string,
  sessionId: string
): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/projects/${projectId}/sessions/${sessionId}/stop`, {
    method: 'POST',
  });
}

export async function resetIdleTimer(
  projectId: string,
  sessionId: string
): Promise<{ cleanupAt: number }> {
  return request<{ cleanupAt: number }>(`/api/projects/${projectId}/sessions/${sessionId}/idle-reset`, {
    method: 'POST',
  });
}

// persistChatMessage removed — messages are now persisted exclusively by the
// VM agent. See: specs/021-task-chat-architecture (US1).

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

// =============================================================================
// Nodes
// =============================================================================
export async function listNodes(): Promise<NodeResponse[]> {
  return request<NodeResponse[]>('/api/nodes');
}

export async function getNode(id: string): Promise<NodeResponse> {
  return request<NodeResponse>(`/api/nodes/${id}`);
}

export async function createNode(data: CreateNodeRequest): Promise<NodeResponse> {
  return request<NodeResponse>('/api/nodes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function stopNode(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/nodes/${id}/stop`, {
    method: 'POST',
  });
}

export async function deleteNode(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/nodes/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Fetch node system info via the control plane proxy.
 * Proxied for the same reason as events (vm-* DNS lacks SSL).
 */
export async function getNodeSystemInfo(nodeId: string): Promise<NodeSystemInfo> {
  return request<NodeSystemInfo>(`/api/nodes/${nodeId}/system-info`);
}

/**
 * Fetch node logs via the control plane proxy.
 */
export async function getNodeLogs(
  nodeId: string,
  filter?: Partial<NodeLogFilter>
): Promise<NodeLogResponse> {
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level) params.set('level', filter.level);
  if (filter?.container) params.set('container', filter.container);
  if (filter?.since) params.set('since', filter.since);
  if (filter?.until) params.set('until', filter.until);
  if (filter?.search) params.set('search', filter.search);
  if (filter?.cursor) params.set('cursor', filter.cursor);
  if (filter?.limit) params.set('limit', String(filter.limit));

  const qs = params.toString();
  return request<NodeLogResponse>(
    `/api/nodes/${nodeId}/logs${qs ? `?${qs}` : ''}`
  );
}

/** Build the WebSocket URL for real-time log streaming. */
export function getNodeLogStreamUrl(nodeId: string, filter?: Partial<NodeLogFilter>): string {
  const base = API_URL.replace(/^http/, 'ws');
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level) params.set('level', filter.level);
  if (filter?.container) params.set('container', filter.container);

  const qs = params.toString();
  return `${base}/api/nodes/${nodeId}/logs/stream${qs ? `?${qs}` : ''}`;
}

/**
 * Fetch node events via the control plane proxy.
 * Node events are proxied because vm-* DNS records are DNS-only (no Cloudflare SSL
 * termination), so the browser cannot reach them directly from an HTTPS page.
 */
export async function listNodeEvents(
  nodeId: string,
  limit = 100
): Promise<{ events: Event[]; nextCursor?: string | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));

  return request<{ events: Event[]; nextCursor?: string | null }>(
    `/api/nodes/${nodeId}/events?${params.toString()}`
  );
}

// =============================================================================
// Workspaces
// =============================================================================
export async function listWorkspaces(
  status?: string,
  nodeId?: string,
  projectId?: string
): Promise<WorkspaceResponse[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (nodeId) params.set('nodeId', nodeId);
  if (projectId) params.set('projectId', projectId);
  const url = params.toString() ? `/api/workspaces?${params.toString()}` : '/api/workspaces';
  return request<WorkspaceResponse[]>(url);
}

export async function getWorkspace(id: string): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>(`/api/workspaces/${id}`);
}

export async function createWorkspace(data: CreateWorkspaceRequest): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateWorkspace(
  id: string,
  data: UpdateWorkspaceRequest
): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>(`/api/workspaces/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function stopWorkspace(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/workspaces/${id}/stop`, {
    method: 'POST',
  });
}

export async function restartWorkspace(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/workspaces/${id}/restart`, {
    method: 'POST',
  });
}

export async function rebuildWorkspace(id: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/workspaces/${id}/rebuild`, {
    method: 'POST',
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  return request<void>(`/api/workspaces/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Fetch workspace events directly from the VM Agent.
 * Requires a workspace JWT token for authentication (same as getWorkspaceTabs).
 */
export async function listWorkspaceEvents(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  limit = 100,
  cursor?: string
): Promise<{ events: Event[]; nextCursor?: string | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('token', token);
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(
    `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/events?${params.toString()}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Failed to load workspace events: ${text}`);
  }
  const data = (await res.json()) as { events: Event[]; nextCursor?: string | null };
  return { events: data.events ?? [], nextCursor: data.nextCursor ?? null };
}

// =============================================================================
// Agent Sessions
// =============================================================================
export async function listAgentSessions(workspaceId: string): Promise<AgentSession[]> {
  return request<AgentSession[]>(`/api/workspaces/${workspaceId}/agent-sessions`);
}

/**
 * Fetch agent sessions directly from the VM Agent with live SessionHost state.
 * Returns enriched sessions with hostStatus and viewerCount fields.
 * Requires a workspace JWT token for authentication (same as other VM Agent direct calls).
 */
export async function listAgentSessionsLive(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<AgentSession[]> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/agent-sessions?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Failed to load live agent sessions: ${text}`);
  }
  const data = (await res.json()) as { sessions: AgentSession[] };
  return data.sessions ?? [];
}

export async function createAgentSession(
  workspaceId: string,
  data: CreateAgentSessionRequest = {}
): Promise<AgentSession> {
  return request<AgentSession>(`/api/workspaces/${workspaceId}/agent-sessions`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function renameAgentSession(
  workspaceId: string,
  sessionId: string,
  label: string
): Promise<AgentSession> {
  return request<AgentSession>(`/api/workspaces/${workspaceId}/agent-sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  });
}

export async function stopAgentSession(
  workspaceId: string,
  sessionId: string
): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/api/workspaces/${workspaceId}/agent-sessions/${sessionId}/stop`,
    {
      method: 'POST',
    }
  );
}

export async function suspendAgentSession(
  workspaceId: string,
  sessionId: string
): Promise<AgentSession> {
  return request<AgentSession>(
    `/api/workspaces/${workspaceId}/agent-sessions/${sessionId}/suspend`,
    {
      method: 'POST',
    }
  );
}

export async function resumeAgentSession(
  workspaceId: string,
  sessionId: string
): Promise<AgentSession> {
  return request<AgentSession>(
    `/api/workspaces/${workspaceId}/agent-sessions/${sessionId}/resume`,
    {
      method: 'POST',
    }
  );
}

// =============================================================================
// Terminal
// =============================================================================
export async function getTerminalToken(workspaceId: string): Promise<TerminalTokenResponse> {
  return request<TerminalTokenResponse>('/api/terminal/token', {
    method: 'POST',
    body: JSON.stringify({ workspaceId }),
  });
}

// =============================================================================
// Workspace Tabs (persisted session state from VM Agent)
// =============================================================================

/**
 * Fetch persisted tab state directly from the VM Agent.
 * Requires a workspace JWT token for authentication.
 */
export async function getWorkspaceTabs(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<WorkspaceTab[]> {
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/tabs?token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Failed to load workspace tabs: ${text}`);
  }
  const data = (await res.json()) as { tabs: WorkspaceTab[] };
  return data.tabs ?? [];
}

// =============================================================================
// Agents
// =============================================================================
export async function listAgents(): Promise<{ agents: AgentInfo[] }> {
  return request<{ agents: AgentInfo[] }>('/api/agents');
}

export async function listAgentCredentials(): Promise<{ credentials: AgentCredentialInfo[] }> {
  return request<{ credentials: AgentCredentialInfo[] }>('/api/credentials/agent');
}

export async function saveAgentCredential(
  data: SaveAgentCredentialRequest
): Promise<AgentCredentialInfo> {
  return request<AgentCredentialInfo>('/api/credentials/agent', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function toggleAgentCredential(
  agentType: string,
  credentialKind: string
): Promise<void> {
  return request<void>(`/api/credentials/agent/${agentType}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ credentialKind }),
  });
}

export async function deleteAgentCredentialByKind(
  agentType: string,
  credentialKind: string
): Promise<void> {
  return request<void>(`/api/credentials/agent/${agentType}/${credentialKind}`, {
    method: 'DELETE',
  });
}

export async function deleteAgentCredential(agentType: string): Promise<void> {
  return request<void>(`/api/credentials/agent/${agentType}`, {
    method: 'DELETE',
  });
}

/**
 * Get the full URL for the voice transcription API endpoint.
 * Used by the VoiceButton component to send audio for transcription.
 */
export function getTranscribeApiUrl(): string {
  return `${API_URL}/api/transcribe`;
}

/**
 * Get the full URL for the client error reporting API endpoint.
 * Used by the error reporter to send batched client-side errors.
 */
export function getClientErrorsApiUrl(): string {
  return `${API_URL}/api/client-errors`;
}

// =============================================================================
// Agent Settings
// =============================================================================
export async function getAgentSettings(agentType: string): Promise<AgentSettingsResponse> {
  return request<AgentSettingsResponse>(`/api/agent-settings/${agentType}`);
}

export async function saveAgentSettings(
  agentType: string,
  data: SaveAgentSettingsRequest
): Promise<AgentSettingsResponse> {
  return request<AgentSettingsResponse>(`/api/agent-settings/${agentType}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteAgentSettings(agentType: string): Promise<void> {
  return request<void>(`/api/agent-settings/${agentType}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// Git Integration (direct VM Agent calls via ws-{id} subdomain)
// =============================================================================

export interface GitFileStatus {
  path: string;
  status: string;
  oldPath?: string;
}

export interface GitStatusData {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
}

export interface GitDiffData {
  diff: string;
  filePath: string;
}

export interface GitFileData {
  content: string;
  filePath: string;
}

/**
 * Fetch git status (staged, unstaged, untracked files) from the VM Agent.
 * Calls directly to ws-{id} subdomain, authenticated via workspace JWT token.
 */
export async function getGitStatus(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  worktree?: string
): Promise<GitStatusData> {
  const params = new URLSearchParams({ token });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/status?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git status failed: ${text}`);
  }
  return res.json() as Promise<GitStatusData>;
}

/**
 * Fetch unified diff for a single file from the VM Agent.
 */
export async function getGitDiff(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  filePath: string,
  staged = false,
  worktree?: string
): Promise<GitDiffData> {
  const params = new URLSearchParams({
    token,
    path: filePath,
    staged: String(staged),
  });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/diff?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git diff failed: ${text}`);
  }
  return res.json() as Promise<GitDiffData>;
}

/**
 * Fetch full file content from the VM Agent.
 */
export async function getGitFile(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  filePath: string,
  ref?: string,
  worktree?: string
): Promise<GitFileData> {
  const params = new URLSearchParams({ token, path: filePath });
  if (ref) params.set('ref', ref);
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/file?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git file fetch failed: ${text}`);
  }
  return res.json() as Promise<GitFileData>;
}

// ---------- File Browser (VM Agent direct) ----------

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
  modifiedAt: string;
}

export interface FileListData {
  path: string;
  entries: FileEntry[];
}

/**
 * Fetch directory listing from the VM Agent.
 */
export async function getFileList(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  path = '.',
  worktree?: string
): Promise<FileListData> {
  const params = new URLSearchParams({ token, path });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/list?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File listing failed: ${text}`);
  }
  return res.json() as Promise<FileListData>;
}

/**
 * Fetch a flat list of all file paths in the workspace (recursive find).
 * Used by the command palette for file search.
 */
export async function getFileIndex(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  worktree?: string
): Promise<string[]> {
  const params = new URLSearchParams({ token });
  if (worktree) params.set('worktree', worktree);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/find?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`File find failed: ${text}`);
  }
  const data = (await res.json()) as { files: string[] };
  return data.files;
}

export async function getWorktrees(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<WorktreeListResponse> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worktree list failed: ${text}`);
  }
  return res.json() as Promise<WorktreeListResponse>;
}

export async function getGitBranches(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<GitBranchListResponse> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/git/branches?${params.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Git branch list failed: ${text}`);
  }
  return res.json() as Promise<GitBranchListResponse>;
}

export async function createWorktree(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  request: CreateWorktreeRequest
): Promise<WorktreeInfo> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worktree create failed: ${text}`);
  }
  return res.json() as Promise<WorktreeInfo>;
}

export async function removeWorktree(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  path: string,
  force = false
): Promise<RemoveWorktreeResponse> {
  const params = new URLSearchParams({ token, path, force: String(force) });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Worktree remove failed: ${text}`);
  }
  return res.json() as Promise<RemoveWorktreeResponse>;
}

// =============================================================================
// Admin
// =============================================================================
export async function listAdminUsers(status?: UserStatus): Promise<AdminUsersResponse> {
  const params = status ? `?status=${status}` : '';
  return request<AdminUsersResponse>(`/api/admin/users${params}`);
}

export async function approveOrSuspendUser(
  userId: string,
  action: 'approve' | 'suspend'
): Promise<{ id: string; status: UserStatus }> {
  return request<{ id: string; status: UserStatus }>(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
}

export async function changeUserRole(
  userId: string,
  role: Exclude<UserRole, 'superadmin'>
): Promise<{ id: string; role: UserRole }> {
  return request<{ id: string; role: UserRole }>(`/api/admin/users/${userId}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

// =============================================================================
// Admin Observability (spec 023)
// =============================================================================

export interface AdminErrorsFilter {
  source?: 'client' | 'vm-agent' | 'api' | 'all';
  level?: 'error' | 'warn' | 'info' | 'all';
  search?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  cursor?: string;
}

export async function fetchAdminErrors(
  filter?: AdminErrorsFilter
): Promise<ErrorListResponse> {
  const params = new URLSearchParams();
  if (filter?.source && filter.source !== 'all') params.set('source', filter.source);
  if (filter?.level && filter.level !== 'all') params.set('level', filter.level);
  if (filter?.search) params.set('search', filter.search);
  if (filter?.startTime) params.set('startTime', filter.startTime);
  if (filter?.endTime) params.set('endTime', filter.endTime);
  if (filter?.limit) params.set('limit', String(filter.limit));
  if (filter?.cursor) params.set('cursor', filter.cursor);

  const qs = params.toString();
  return request<ErrorListResponse>(
    `/api/admin/observability/errors${qs ? `?${qs}` : ''}`
  );
}

export async function fetchAdminHealth(): Promise<HealthSummary> {
  return request<HealthSummary>('/api/admin/observability/health');
}

export async function fetchAdminErrorTrends(
  range?: string
): Promise<ErrorTrendResponse> {
  const params = range ? `?range=${range}` : '';
  return request<ErrorTrendResponse>(`/api/admin/observability/trends${params}`);
}

export interface AdminLogQueryParams {
  timeRange: { start: string; end: string };
  levels?: string[];
  search?: string;
  limit?: number;
  cursor?: string | null;
}

export async function queryAdminLogs(
  params: AdminLogQueryParams
): Promise<LogQueryResponse> {
  return request<LogQueryResponse>('/api/admin/observability/logs/query', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
