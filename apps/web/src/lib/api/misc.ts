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
// API Tokens
// ---------------------------------------------------------------------------

export interface ApiTokenResponse {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiTokenResponse {
  id: string;
  token: string;
  name: string;
}

/** List all API tokens for the current user */
export async function listApiTokens(): Promise<ApiTokenResponse[]> {
  return request<ApiTokenResponse[]>('/api/auth/api-tokens');
}

/** Create a new API token */
export async function createApiToken(name: string): Promise<CreateApiTokenResponse> {
  return request<CreateApiTokenResponse>('/api/auth/api-tokens', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/** Revoke a API token */
export async function revokeApiToken(id: string): Promise<void> {
  await request<{ success: boolean }>(`/api/auth/api-tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
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

// -------------------------------------------------------------------------
// CLI Device Flow
// -------------------------------------------------------------------------

export async function approveDeviceCode(userCode: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/auth/device/approve', {
    method: 'POST',
    body: JSON.stringify({ userCode }),
  });
}
