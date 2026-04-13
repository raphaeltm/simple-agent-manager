import { request } from './client';

// -------------------------------------------------------------------------
// Cached Commands
// -------------------------------------------------------------------------

export interface CachedCommandResponse {
  agentType: string;
  name: string;
  description: string;
  updatedAt: number;
}

export async function getCachedCommands(
  projectId: string,
  agentType?: string,
): Promise<{ commands: CachedCommandResponse[] }> {
  const qs = agentType ? `?agentType=${encodeURIComponent(agentType)}` : '';
  return request<{ commands: CachedCommandResponse[] }>(
    `/api/projects/${projectId}/cached-commands${qs}`,
  );
}

export async function saveCachedCommands(
  projectId: string,
  agentType: string,
  commands: Array<{ name: string; description: string }>,
): Promise<{ cached: number }> {
  return request<{ cached: number }>(`/api/projects/${projectId}/cached-commands`, {
    method: 'POST',
    body: JSON.stringify({ agentType, commands }),
  });
}

// ---------------------------------------------------------------------------
// Smoke Test Auth Tokens
// ---------------------------------------------------------------------------

export interface SmokeTestStatusResponse {
  enabled: boolean;
}

export interface SmokeTestTokenResponse {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateSmokeTestTokenResponse {
  id: string;
  token: string;
  name: string;
}

/** Check if smoke test token auth is enabled in this environment */
export async function getSmokeTestStatus(): Promise<SmokeTestStatusResponse> {
  return request<SmokeTestStatusResponse>('/api/auth/smoke-test-status');
}

/** List all smoke test tokens for the current user */
export async function listSmokeTestTokens(): Promise<SmokeTestTokenResponse[]> {
  return request<SmokeTestTokenResponse[]>('/api/auth/smoke-test-tokens');
}

/** Create a new smoke test token */
export async function createSmokeTestToken(name: string): Promise<CreateSmokeTestTokenResponse> {
  return request<CreateSmokeTestTokenResponse>('/api/auth/smoke-test-tokens', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/** Revoke a smoke test token */
export async function revokeSmokeTestToken(id: string): Promise<void> {
  await request<{ success: boolean }>(`/api/auth/smoke-test-tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// Browser Sidecar (Neko)
// =============================================================================

export interface BrowserSidecarStatusResponse {
  status: 'off' | 'starting' | 'running' | 'error';
  url?: string;
  /** URL with auto-login query params (?usr=user&pwd=...) for seamless Neko access. */
  autoLoginUrl?: string;
  containerName?: string;
  error?: string;
  ports?: Array<{ port: number; targetHost: string; active: boolean }>;
}

/** Start a browser sidecar for a workspace session. */
export async function startBrowserSidecar(
  projectId: string,
  sessionId: string,
  opts?: {
    viewportWidth?: number;
    viewportHeight?: number;
    devicePixelRatio?: number;
    isTouchDevice?: boolean;
    enableAudio?: boolean;
    userAgent?: string;
    startURL?: string;
  }
): Promise<BrowserSidecarStatusResponse> {
  return request<BrowserSidecarStatusResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/browser`,
    {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }
  );
}

/** Get the status of a browser sidecar for a workspace session. */
export async function getBrowserSidecarStatus(
  projectId: string,
  sessionId: string
): Promise<BrowserSidecarStatusResponse> {
  return request<BrowserSidecarStatusResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/browser`
  );
}

/** Stop the browser sidecar for a workspace session. */
export async function stopBrowserSidecar(
  projectId: string,
  sessionId: string
): Promise<BrowserSidecarStatusResponse> {
  return request<BrowserSidecarStatusResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/browser`,
    { method: 'DELETE' }
  );
}

/** Get the active socat forwarders for a workspace session's browser sidecar. */
export async function getBrowserSidecarPorts(
  projectId: string,
  sessionId: string
): Promise<{ ports: Array<{ port: number; targetHost: string; active: boolean }> }> {
  return request<{ ports: Array<{ port: number; targetHost: string; active: boolean }> }>(
    `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/browser/ports`
  );
}

// === Workspace-level Browser Sidecar (no session required) ===

/** Start a browser sidecar for a workspace (direct, no session). */
export async function startWorkspaceBrowserSidecar(
  workspaceId: string,
  opts?: {
    viewportWidth?: number;
    viewportHeight?: number;
    devicePixelRatio?: number;
    isTouchDevice?: boolean;
    enableAudio?: boolean;
    userAgent?: string;
    startURL?: string;
  }
): Promise<BrowserSidecarStatusResponse> {
  return request<BrowserSidecarStatusResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/browser`,
    {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }
  );
}

/** Get the status of a workspace's browser sidecar (direct, no session). */
export async function getWorkspaceBrowserSidecarStatus(
  workspaceId: string
): Promise<BrowserSidecarStatusResponse> {
  return request<BrowserSidecarStatusResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/browser`
  );
}

/** Stop the browser sidecar for a workspace (direct, no session). */
export async function stopWorkspaceBrowserSidecar(
  workspaceId: string
): Promise<BrowserSidecarStatusResponse> {
  return request<BrowserSidecarStatusResponse>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/browser`,
    { method: 'DELETE' }
  );
}

/** Get the active socat forwarders for a workspace's browser sidecar (direct, no session). */
export async function getWorkspaceBrowserSidecarPorts(
  workspaceId: string
): Promise<{ ports: Array<{ port: number; targetHost: string; active: boolean }> }> {
  return request<{ ports: Array<{ port: number; targetHost: string; active: boolean }> }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/browser/ports`
  );
}

// -------------------------------------------------------------------------
// Platform Trial Status
// -------------------------------------------------------------------------

export interface TrialStatusResponse {
  available: boolean;
  agentType: 'opencode' | null;
  hasInfraCredential: boolean;
  hasAgentCredential: boolean;
  dailyTokenBudget: { input: number; output: number } | null;
  dailyTokenUsage: { input: number; output: number } | null;
}

export async function getTrialStatus(): Promise<TrialStatusResponse> {
  return request<TrialStatusResponse>('/api/trial-status');
}
