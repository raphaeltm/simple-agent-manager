import type {
  User,
  NodeResponse,
  CreateNodeRequest,
  WorkspaceResponse,
  CreateWorkspaceRequest,
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

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
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
      throw new ApiClientError('UNKNOWN_ERROR', 'Server returned non-JSON response', response.status);
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
 * Get a node-scoped management token for direct VM Agent access.
 * Used to fetch node events, health data, etc. directly from the VM Agent.
 */
export async function getNodeToken(nodeId: string): Promise<{ token: string; expiresAt: string; nodeAgentUrl: string }> {
  return request<{ token: string; expiresAt: string; nodeAgentUrl: string }>(`/api/nodes/${nodeId}/token`, {
    method: 'POST',
  });
}


/**
 * Fetch node events directly from the VM Agent.
 * Requires a node management token obtained from getNodeToken().
 */
export async function listNodeEvents(
  nodeAgentUrl: string,
  token: string,
  limit = 100,
  cursor?: string
): Promise<{ events: Event[]; nextCursor?: string | null }> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('token', token);
  if (cursor) params.set('cursor', cursor);

  try {
    const res = await fetch(`${nodeAgentUrl}/events?${params.toString()}`);
    if (!res.ok) {
      return { events: [], nextCursor: null };
    }
    const data = await res.json() as { events: Event[]; nextCursor?: string | null };
    return { events: data.events ?? [], nextCursor: data.nextCursor ?? null };
  } catch {
    return { events: [], nextCursor: null };
  }
}

// =============================================================================
// Workspaces
// =============================================================================
export async function listWorkspaces(status?: string, nodeId?: string): Promise<WorkspaceResponse[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (nodeId) params.set('nodeId', nodeId);
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

export async function updateWorkspace(id: string, data: UpdateWorkspaceRequest): Promise<WorkspaceResponse> {
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

  try {
    const res = await fetch(
      `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/events?${params.toString()}`
    );
    if (!res.ok) {
      return { events: [], nextCursor: null };
    }
    const data = await res.json() as { events: Event[]; nextCursor?: string | null };
    return { events: data.events ?? [], nextCursor: data.nextCursor ?? null };
  } catch {
    return { events: [], nextCursor: null };
  }
}

// =============================================================================
// Agent Sessions
// =============================================================================
export async function listAgentSessions(workspaceId: string): Promise<AgentSession[]> {
  return request<AgentSession[]>(`/api/workspaces/${workspaceId}/agent-sessions`);
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

export async function stopAgentSession(workspaceId: string, sessionId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/workspaces/${workspaceId}/agent-sessions/${sessionId}/stop`, {
    method: 'POST',
  });
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
    return [];
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

export async function saveAgentCredential(data: SaveAgentCredentialRequest): Promise<AgentCredentialInfo> {
  return request<AgentCredentialInfo>('/api/credentials/agent', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function toggleAgentCredential(agentType: string, credentialKind: string): Promise<void> {
  return request<void>(`/api/credentials/agent/${agentType}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ credentialKind }),
  });
}

export async function deleteAgentCredentialByKind(agentType: string, credentialKind: string): Promise<void> {
  return request<void>(`/api/credentials/agent/${agentType}/${credentialKind}`, {
    method: 'DELETE',
  });
}

export async function deleteAgentCredential(agentType: string): Promise<void> {
  return request<void>(`/api/credentials/agent/${agentType}`, {
    method: 'DELETE',
  });
}
