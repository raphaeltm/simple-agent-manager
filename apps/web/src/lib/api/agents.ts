import type {
  AgentInfo,
  AgentCredentialInfo,
  SaveAgentCredentialRequest,
  AgentSettingsResponse,
  SaveAgentSettingsRequest,
} from '@simple-agent-manager/shared';
import { API_URL, request } from './client';

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
