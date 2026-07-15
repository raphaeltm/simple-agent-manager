import type { GitLabProjectListResponse } from '@simple-agent-manager/shared';

import { request } from './client';

export async function listGitLabProjects(search?: string): Promise<GitLabProjectListResponse> {
  const params = new URLSearchParams();
  if (search?.trim()) {
    params.set('search', search.trim());
  }
  const qs = params.toString();
  return request<GitLabProjectListResponse>(`/api/gitlab/projects${qs ? `?${qs}` : ''}`);
}

export async function listGitLabBranches(projectId: number): Promise<Array<{ name: string }>> {
  const params = new URLSearchParams({ project_id: String(projectId) });
  return request<Array<{ name: string }>>(`/api/gitlab/branches?${params.toString()}`);
}
