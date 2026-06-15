import type {
  AgentCredentialInfo,
  AgentInfo,
  AgentProfile,
  AgentSettingsResponse,
  AgentSkill,
  CreateAgentProfileRequest,
  CreateSkillRequest,
  ProjectRuntimeConfigResponse,
  SaveAgentCredentialRequest,
  SaveAgentSettingsRequest,
  UpdateAgentProfileRequest,
  UpdateSkillRequest,
  UpsertProjectRuntimeEnvVarRequest,
  UpsertProjectRuntimeFileRequest,
} from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

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
  return request<void>(`/api/credentials/agent/${encodeURIComponent(agentType)}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ credentialKind }),
  });
}

export async function deleteAgentCredentialByKind(
  agentType: string,
  credentialKind: string
): Promise<void> {
  return request<void>(
    `/api/credentials/agent/${encodeURIComponent(agentType)}/${encodeURIComponent(credentialKind)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function deleteAgentCredential(agentType: string): Promise<void> {
  return request<void>(`/api/credentials/agent/${encodeURIComponent(agentType)}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// Project-Scoped Agent Credentials (Phase 2 of multi-level config override)
// =============================================================================

export async function listProjectAgentCredentials(
  projectId: string
): Promise<{ credentials: AgentCredentialInfo[] }> {
  return request<{ credentials: AgentCredentialInfo[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/credentials`
  );
}

export async function saveProjectAgentCredential(
  projectId: string,
  data: SaveAgentCredentialRequest
): Promise<AgentCredentialInfo> {
  return request<AgentCredentialInfo>(
    `/api/projects/${encodeURIComponent(projectId)}/credentials`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
}

export async function deleteProjectAgentCredential(
  projectId: string,
  agentType: string,
  credentialKind: string
): Promise<void> {
  return request<void>(
    `/api/projects/${encodeURIComponent(projectId)}/credentials/${encodeURIComponent(agentType)}/${encodeURIComponent(credentialKind)}`,
    { method: 'DELETE' }
  );
}

/**
 * Get the full URL for the voice transcription API endpoint.
 * Used by the VoiceButton component to send audio for transcription.
 */
export function getTranscribeApiUrl(): string {
  return `${API_URL}/api/transcribe`;
}

/**
 * Get the full URL for the TTS API endpoint.
 * Used by MessageActions to generate and retrieve text-to-speech audio.
 */
export function getTtsApiUrl(): string {
  return `${API_URL}/api/tts`;
}

/**
 * Get the full URL for the client error reporting API endpoint.
 * Used by the error reporter to send batched client-side errors.
 */
export function getClientErrorsApiUrl(): string {
  return `${API_URL}/api/client-errors`;
}

/**
 * Get the full URL for the analytics ingest endpoint.
 * Used by the client-side analytics tracker to send batched events.
 */
export function getAnalyticsApiUrl(): string {
  return `${API_URL}/api/t`;
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
// Agent Profiles
// =============================================================================

export async function listAgentProfiles(projectId: string): Promise<AgentProfile[]> {
  const res = await request<{ items: AgentProfile[] }>(`/api/projects/${projectId}/agent-profiles`);
  return res.items ?? [];
}

export async function createAgentProfile(
  projectId: string,
  data: CreateAgentProfileRequest
): Promise<AgentProfile> {
  return request<AgentProfile>(`/api/projects/${projectId}/agent-profiles`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateAgentProfile(
  projectId: string,
  profileId: string,
  data: UpdateAgentProfileRequest
): Promise<AgentProfile> {
  return request<AgentProfile>(`/api/projects/${projectId}/agent-profiles/${profileId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteAgentProfile(projectId: string, profileId: string): Promise<void> {
  await request(`/api/projects/${projectId}/agent-profiles/${profileId}`, {
    method: 'DELETE',
  });
}

// =============================================================================
// Profile Runtime Assets (Env Vars & Files)
// =============================================================================

export async function getProfileRuntimeConfig(
  projectId: string,
  profileId: string
): Promise<ProjectRuntimeConfigResponse> {
  const [envRes, filesRes] = await Promise.all([
    request<{ envVars: ProjectRuntimeConfigResponse['envVars'] }>(
      `/api/projects/${projectId}/agent-profiles/${profileId}/runtime/env-vars`
    ),
    request<{ files: ProjectRuntimeConfigResponse['files'] }>(
      `/api/projects/${projectId}/agent-profiles/${profileId}/runtime/files`
    ),
  ]);
  return { envVars: envRes.envVars, files: filesRes.files };
}

export async function upsertProfileRuntimeEnvVar(
  projectId: string,
  profileId: string,
  data: UpsertProjectRuntimeEnvVarRequest
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/agent-profiles/${profileId}/runtime/env-vars`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function deleteProfileRuntimeEnvVar(
  projectId: string,
  profileId: string,
  envKey: string
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/agent-profiles/${profileId}/runtime/env-vars/${encodeURIComponent(envKey)}`,
    { method: 'DELETE' }
  );
}

export async function upsertProfileRuntimeFile(
  projectId: string,
  profileId: string,
  data: UpsertProjectRuntimeFileRequest
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/agent-profiles/${profileId}/runtime/files`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function deleteProfileRuntimeFile(
  projectId: string,
  profileId: string,
  path: string
): Promise<ProjectRuntimeConfigResponse> {
  const params = new URLSearchParams({ path });
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/agent-profiles/${profileId}/runtime/files?${params.toString()}`,
    { method: 'DELETE' }
  );
}

// =============================================================================
// Skills
// =============================================================================

export async function listSkills(projectId: string): Promise<AgentSkill[]> {
  const res = await request<{ items: AgentSkill[] }>(`/api/projects/${projectId}/skills`);
  return res.items;
}

export async function createSkill(
  projectId: string,
  data: CreateSkillRequest
): Promise<AgentSkill> {
  return request<AgentSkill>(`/api/projects/${projectId}/skills`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateSkill(
  projectId: string,
  skillId: string,
  data: UpdateSkillRequest
): Promise<AgentSkill> {
  return request<AgentSkill>(`/api/projects/${projectId}/skills/${skillId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteSkill(projectId: string, skillId: string): Promise<void> {
  await request(`/api/projects/${projectId}/skills/${skillId}`, { method: 'DELETE' });
}

export async function getSkillRuntimeConfig(
  projectId: string,
  skillId: string
): Promise<ProjectRuntimeConfigResponse> {
  const [envRes, filesRes] = await Promise.all([
    request<{ envVars: ProjectRuntimeConfigResponse['envVars'] }>(
      `/api/projects/${projectId}/skills/${skillId}/runtime/env-vars`
    ),
    request<{ files: ProjectRuntimeConfigResponse['files'] }>(
      `/api/projects/${projectId}/skills/${skillId}/runtime/files`
    ),
  ]);
  return { envVars: envRes.envVars, files: filesRes.files };
}

export async function upsertSkillRuntimeEnvVar(
  projectId: string,
  skillId: string,
  data: UpsertProjectRuntimeEnvVarRequest
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/skills/${skillId}/runtime/env-vars`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function deleteSkillRuntimeEnvVar(
  projectId: string,
  skillId: string,
  envKey: string
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/skills/${skillId}/runtime/env-vars/${encodeURIComponent(envKey)}`,
    { method: 'DELETE' }
  );
}

export async function upsertSkillRuntimeFile(
  projectId: string,
  skillId: string,
  data: UpsertProjectRuntimeFileRequest
): Promise<ProjectRuntimeConfigResponse> {
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/skills/${skillId}/runtime/files`,
    { method: 'POST', body: JSON.stringify(data) }
  );
}

export async function deleteSkillRuntimeFile(
  projectId: string,
  skillId: string,
  path: string
): Promise<ProjectRuntimeConfigResponse> {
  const params = new URLSearchParams({ path });
  return request<ProjectRuntimeConfigResponse>(
    `/api/projects/${projectId}/skills/${skillId}/runtime/files?${params.toString()}`,
    { method: 'DELETE' }
  );
}
