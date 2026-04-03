import type { CreateCredentialRequest, CredentialResponse } from '@simple-agent-manager/shared';

import { request } from './client';

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
// GCP OIDC
// =============================================================================

export interface GcpProject {
  projectId: string;
  name: string;
  projectNumber: string;
}

export async function listGcpProjects(oauthHandle: string): Promise<{ projects: GcpProject[] }> {
  return request<{ projects: GcpProject[] }>('/api/gcp/projects', {
    method: 'POST',
    body: JSON.stringify({ oauthHandle }),
  });
}

export interface GcpSetupRequest {
  oauthHandle: string;
  gcpProjectId: string;
  defaultZone: string;
}

export interface GcpSetupResponse {
  success: boolean;
  verified: boolean;
  credential?: {
    gcpProjectId: string;
    gcpProjectNumber: string;
    serviceAccountEmail: string;
    defaultZone: string;
  };
  warning?: string;
}

export async function runGcpSetup(data: GcpSetupRequest): Promise<GcpSetupResponse> {
  return request<GcpSetupResponse>('/api/gcp/setup', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function verifyGcpSetup(): Promise<{ success: boolean; verified: boolean; error?: string }> {
  return request<{ success: boolean; verified: boolean; error?: string }>('/api/gcp/verify', {
    method: 'POST',
  });
}

export async function getGcpOAuthResult(): Promise<{ handle: string }> {
  return request<{ handle: string }>('/auth/google/oauth-result');
}
