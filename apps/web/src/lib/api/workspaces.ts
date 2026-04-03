import type {
  AgentSession,
  CreateAgentSessionRequest,
  CreateWorkspaceRequest,
  DetectedPort,
  Event,
  TerminalTokenResponse,
  UpdateWorkspaceRequest,
  WorkspaceResponse,
  WorkspaceTab,
} from '@simple-agent-manager/shared';

import { request } from './client';

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
// Port Detection
// =============================================================================

/**
 * Fetch detected ports from the VM Agent.
 * Requires a workspace JWT token for authentication.
 */
export async function listWorkspacePorts(
  workspaceUrl: string,
  workspaceId: string,
  token: string
): Promise<DetectedPort[]> {
  const params = new URLSearchParams();
  params.set('token', token);

  const res = await fetch(
    `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/ports?${params.toString()}`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => 'Unknown error');
    throw new Error(`Failed to load workspace ports: ${text}`);
  }
  const data = (await res.json()) as { ports: DetectedPort[] };
  return data.ports ?? [];
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
