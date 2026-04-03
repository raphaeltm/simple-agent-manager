import type { GitHubInstallation, RepositoryListResponse } from '@simple-agent-manager/shared';

import { request } from './client';

export async function listGitHubInstallations(): Promise<GitHubInstallation[]> {
  return request<GitHubInstallation[]>('/api/github/installations');
}

export async function getGitHubInstallUrl(): Promise<{ url: string }> {
  return request<{ url: string }>('/api/github/install-url');
}

export async function listRepositories(installationId?: string): Promise<RepositoryListResponse> {
  const url = installationId
    ? `/api/github/repositories?installation_id=${installationId}`
    : '/api/github/repositories';
  return request<RepositoryListResponse>(url);
}

export async function listBranches(
  repository: string,
  installationId?: string,
  defaultBranch?: string
): Promise<Array<{ name: string }>> {
  const params = new URLSearchParams({ repository });
  if (installationId) {
    params.set('installation_id', installationId);
  }
  if (defaultBranch) {
    params.set('default_branch', defaultBranch);
  }
  return request<Array<{ name: string }>>(`/api/github/branches?${params.toString()}`);
}
