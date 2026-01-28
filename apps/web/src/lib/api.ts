import type {
  User,
  WorkspaceResponse,
  CreateWorkspaceRequest,
  CredentialResponse,
  CreateCredentialRequest,
  GitHubInstallation,
  Repository,
  TerminalTokenResponse,
  ApiError,
} from '@simple-agent-manager/shared';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

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
// Workspaces
// =============================================================================
export async function listWorkspaces(status?: string): Promise<WorkspaceResponse[]> {
  const url = status ? `/api/workspaces?status=${status}` : '/api/workspaces';
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

export async function stopWorkspace(id: string): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>(`/api/workspaces/${id}/stop`, {
    method: 'POST',
  });
}

export async function restartWorkspace(id: string): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>(`/api/workspaces/${id}/restart`, {
    method: 'POST',
  });
}

export async function deleteWorkspace(id: string): Promise<void> {
  return request<void>(`/api/workspaces/${id}`, {
    method: 'DELETE',
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
