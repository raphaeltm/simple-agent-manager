import type {
  RepoBranchesResponse,
  RepoCompareResponse,
  RepoFileContent,
  RepoTreeResponse,
} from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

/** List branches for a project's remote repo (default branch first). */
export function getRepoBranches(projectId: string): Promise<RepoBranchesResponse> {
  return request<RepoBranchesResponse>(`/api/projects/${projectId}/repo/branches`);
}

/** Full recursive tree at a ref (web derives directory nav + filename search). */
export function getRepoTree(projectId: string, ref: string): Promise<RepoTreeResponse> {
  const q = new URLSearchParams({ ref });
  return request<RepoTreeResponse>(`/api/projects/${projectId}/repo/tree?${q.toString()}`);
}

/** Text file content at ref/path (or metadata + rawUrl for binary/oversized). */
export function getRepoFile(
  projectId: string,
  ref: string,
  path: string
): Promise<RepoFileContent> {
  const q = new URLSearchParams({ ref, path });
  return request<RepoFileContent>(`/api/projects/${projectId}/repo/file?${q.toString()}`);
}

/** Changed files (with unified-diff patches) comparing head vs base (default branch). */
export function getRepoCompare(
  projectId: string,
  head: string,
  base?: string
): Promise<RepoCompareResponse> {
  const q = new URLSearchParams({ head });
  if (base) q.set('base', base);
  return request<RepoCompareResponse>(`/api/projects/${projectId}/repo/compare?${q.toString()}`);
}

/** Absolute URL for streaming raw file bytes (images, binary, oversized). */
export function repoRawUrl(projectId: string, ref: string, path: string): string {
  const q = new URLSearchParams({ ref, path });
  return `${API_URL}/api/projects/${projectId}/repo/raw?${q.toString()}`;
}
