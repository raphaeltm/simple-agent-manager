import type {
  CCProfileAttachmentItem,
  CCProfilePinCandidatesResponse,
  CCResolutionStatusResponse,
  SessionAgentCredentialResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

function pathId(id: string): string {
  return encodeURIComponent(id);
}

// Resolution status (read-only view of how each consumer currently resolves)
export async function getResolutionStatus(projectId?: string): Promise<CCResolutionStatusResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request<CCResolutionStatusResponse>(`/api/credentials/resolution-status${query}`);
}

// Types matching the API responses
export interface CCCredentialListItem {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CCConfigurationListItem {
  id: string;
  name: string;
  consumerKind: string;
  consumerTarget: string;
  credentialId: string | null;
  settingsJson: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CCAttachmentListItem {
  id: string;
  configurationId: string;
  consumerKind: string;
  consumerTarget: string;
  projectId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// Credentials
export async function listCCCredentials(): Promise<CCCredentialListItem[]> {
  const data = await request<{ credentials: CCCredentialListItem[] }>('/api/cc/credentials');
  return data.credentials;
}

export async function createCCCredential(body: {
  name: string;
  kind: string;
  secret: string;
}): Promise<{ id: string; name: string; kind: string }> {
  return request('/api/cc/credentials', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateCCCredential(
  id: string,
  body: { name?: string; isActive?: boolean }
): Promise<{ success: boolean }> {
  return request(`/api/cc/credentials/${pathId(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteCCCredential(id: string): Promise<{ success: boolean }> {
  return request(`/api/cc/credentials/${pathId(id)}`, { method: 'DELETE' });
}

// Configurations
export async function listCCConfigurations(): Promise<CCConfigurationListItem[]> {
  const data = await request<{ configurations: CCConfigurationListItem[] }>(
    '/api/cc/configurations'
  );
  return data.configurations;
}

export async function createCCConfiguration(body: {
  name: string;
  consumerKind: string;
  consumerTarget: string;
  credentialId?: string;
  settings?: Record<string, unknown>;
}): Promise<{ id: string }> {
  return request('/api/cc/configurations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateCCConfiguration(
  id: string,
  body: {
    name?: string;
    credentialId?: string | null;
    settings?: Record<string, unknown>;
    isActive?: boolean;
  }
): Promise<{ success: boolean }> {
  return request(`/api/cc/configurations/${pathId(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteCCConfiguration(id: string): Promise<{ success: boolean }> {
  return request(`/api/cc/configurations/${pathId(id)}`, { method: 'DELETE' });
}

// Attachments
export async function listCCAttachments(): Promise<CCAttachmentListItem[]> {
  const data = await request<{ attachments: CCAttachmentListItem[] }>('/api/cc/attachments');
  return data.attachments;
}

export async function createCCAttachment(body: {
  configurationId: string;
  projectId?: string;
}): Promise<{ id: string }> {
  return request('/api/cc/attachments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Make an existing agent account the default for its agent, replacing the current one. */
export async function makeCCDefault(configurationId: string): Promise<{ id: string }> {
  return request('/api/cc/attachments/default', {
    method: 'POST',
    body: JSON.stringify({ configurationId }),
  });
}

export async function updateCCAttachment(
  id: string,
  body: { isActive?: boolean }
): Promise<{ success: boolean }> {
  return request(`/api/cc/attachments/${pathId(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteCCAttachment(id: string): Promise<{ success: boolean }> {
  return request(`/api/cc/attachments/${pathId(id)}`, { method: 'DELETE' });
}

// Personal profile pins — "when I run this profile, use this account of mine"
export async function listProfilePins(): Promise<CCProfileAttachmentItem[]> {
  const data = await request<{ attachments: CCProfileAttachmentItem[] }>(
    '/api/cc/profile-attachments'
  );
  return data.attachments;
}

export async function listProfilePinCandidates(
  agentType?: string
): Promise<CCProfilePinCandidatesResponse> {
  const query = agentType ? `?agentType=${encodeURIComponent(agentType)}` : '';
  return request<CCProfilePinCandidatesResponse>(`/api/cc/profile-attachments/profiles${query}`);
}

/** Replaces my previous pin for that profile and agent. */
export async function createProfilePin(body: {
  configurationId: string;
  profileId: string;
}): Promise<{ id: string }> {
  return request('/api/cc/profile-attachments', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteProfilePin(id: string): Promise<{ success: boolean }> {
  return request(`/api/cc/profile-attachments/${pathId(id)}`, { method: 'DELETE' });
}

/** Which account a chat's agent ran on, and which tier chose it. */
export async function getSessionAgentCredential(
  projectId: string,
  sessionId: string
): Promise<SessionAgentCredentialResponse> {
  return request<SessionAgentCredentialResponse>(
    `/api/projects/${pathId(projectId)}/sessions/${pathId(sessionId)}/agent-credential`
  );
}
