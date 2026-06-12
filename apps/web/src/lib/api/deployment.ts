import { request } from './client';
import type { GcpProject } from './credentials';

// ─── Environment Secrets (write-only) ──────────────────────────────────────

export interface DeploymentSecretEntry {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export async function listDeploymentSecrets(
  projectId: string,
  envId: string,
): Promise<{ secrets: DeploymentSecretEntry[] }> {
  return request<{ secrets: DeploymentSecretEntry[] }>(
    `/api/projects/${projectId}/environments/${envId}/secrets`,
  );
}

export async function setDeploymentSecret(
  projectId: string,
  envId: string,
  name: string,
  value: string,
): Promise<{ name: string; created: boolean; updatedAt: string }> {
  return request<{ name: string; created: boolean; updatedAt: string }>(
    `/api/projects/${projectId}/environments/${envId}/secrets/${encodeURIComponent(name)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  );
}

export async function deleteDeploymentSecret(
  projectId: string,
  envId: string,
  name: string,
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    `/api/projects/${projectId}/environments/${envId}/secrets/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

// ─── Project Deployment (GCP OIDC for Defang) ─────────────────────────────

export interface ProjectDeploymentGcpResponse {
  connected: boolean;
  provider?: 'gcp';
  gcpProjectId?: string;
  serviceAccountEmail?: string;
  createdAt?: string;
}

export async function getProjectDeploymentGcp(projectId: string): Promise<ProjectDeploymentGcpResponse> {
  return request<ProjectDeploymentGcpResponse>(`/api/projects/${projectId}/deployment/gcp`);
}

export async function setupProjectDeploymentGcp(
  projectId: string,
  data: { oauthHandle: string; gcpProjectId: string },
): Promise<{ success: boolean; credential: ProjectDeploymentGcpResponse }> {
  return request<{ success: boolean; credential: ProjectDeploymentGcpResponse }>(
    `/api/projects/${projectId}/deployment/gcp/setup`,
    { method: 'POST', body: JSON.stringify(data) },
  );
}

export async function deleteProjectDeploymentGcp(projectId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/projects/${projectId}/deployment/gcp`, {
    method: 'DELETE',
  });
}

export async function listGcpProjectsForDeploy(
  projectId: string,
  oauthHandle: string,
): Promise<{ projects: GcpProject[] }> {
  return request<{ projects: GcpProject[] }>(
    `/api/projects/${projectId}/deployment/gcp/projects`,
    { method: 'POST', body: JSON.stringify({ oauthHandle }) },
  );
}

/**
 * Retrieve the OAuth handle after the GCP deployment callback redirect.
 * The handle is stored server-side and never appears in the URL.
 */
export async function getDeployOAuthResult(projectId: string): Promise<{ handle: string }> {
  return request<{ handle: string }>(
    `/api/projects/${projectId}/deployment/gcp/oauth-result`,
  );
}
