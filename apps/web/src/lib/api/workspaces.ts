import type {
  WorkspaceResponse,
  CreateWorkspaceRequest,
  UpdateWorkspaceRequest,
  TerminalTokenResponse,
  AgentSession,
  CreateAgentSessionRequest,
  Event,
  WorkspaceTab,
  WorktreeInfo,
  WorktreeListResponse,
  CreateWorktreeRequest,
  RemoveWorktreeResponse,
  GitBranchListResponse,
  DetectedPort,
} from '@simple-agent-manager/shared';
import { request } from './client';

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
  req: CreateWorktreeRequest
): Promise<WorktreeInfo> {
  const params = new URLSearchParams({ token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/worktrees?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
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
