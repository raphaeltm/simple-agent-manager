import type {
  RepoBranchesResponse,
  RepoCompareResponse,
  RepoFileContent,
  RepoTreeResponse,
} from '@simple-agent-manager/shared';

import { API_URL, request } from './client';

// ---------------------------------------------------------------------------
// In-memory cache for expensive repo browse data
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const TREE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BRANCHES_TTL_MS = 5 * 60 * 1000;
const COMPARE_TTL_MS = 2 * 60 * 1000;

const treeCache = new Map<string, CacheEntry<RepoTreeResponse>>();
const branchesCache = new Map<string, CacheEntry<RepoBranchesResponse>>();
const compareCache = new Map<string, CacheEntry<RepoCompareResponse>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string, ttl: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// API functions (with caching where appropriate)
// ---------------------------------------------------------------------------

/** List branches for a project's remote repo (default branch first). */
export async function getRepoBranches(projectId: string): Promise<RepoBranchesResponse> {
  const cacheKey = projectId;
  const cached = getCached(branchesCache, cacheKey, BRANCHES_TTL_MS);
  if (cached) return cached;

  const data = await request<RepoBranchesResponse>(`/api/projects/${projectId}/repo/branches`);
  setCache(branchesCache, cacheKey, data);
  return data;
}

/** Full recursive tree at a ref (web derives directory nav + filename search). */
export async function getRepoTree(projectId: string, ref: string): Promise<RepoTreeResponse> {
  const cacheKey = `${projectId}:${ref}`;
  const cached = getCached(treeCache, cacheKey, TREE_TTL_MS);
  if (cached) return cached;

  const q = new URLSearchParams({ ref });
  const data = await request<RepoTreeResponse>(`/api/projects/${projectId}/repo/tree?${q.toString()}`);
  setCache(treeCache, cacheKey, data);
  return data;
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
export async function getRepoCompare(
  projectId: string,
  head: string,
  base?: string
): Promise<RepoCompareResponse> {
  const cacheKey = `${projectId}:${head}:${base ?? ''}`;
  const cached = getCached(compareCache, cacheKey, COMPARE_TTL_MS);
  if (cached) return cached;

  const q = new URLSearchParams({ head });
  if (base) q.set('base', base);
  const data = await request<RepoCompareResponse>(`/api/projects/${projectId}/repo/compare?${q.toString()}`);
  setCache(compareCache, cacheKey, data);
  return data;
}

/** Absolute URL for streaming raw file bytes (images, binary, oversized). */
export function repoRawUrl(projectId: string, ref: string, path: string): string {
  const q = new URLSearchParams({ ref, path });
  return `${API_URL}/api/projects/${projectId}/repo/raw?${q.toString()}`;
}
