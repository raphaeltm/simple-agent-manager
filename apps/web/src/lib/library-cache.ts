import type { DirectoryEntry, ListFilesResponse } from '@simple-agent-manager/shared';

const CACHE_PREFIX = 'sam-library:';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

function buildKey(projectId: string, type: 'files' | 'dirs', params: string): string {
  return `${CACHE_PREFIX}${projectId}:${type}:${params}`;
}

function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export function getCachedFiles(
  projectId: string,
  directory: string,
  sortBy: string,
): ListFilesResponse | null {
  return readCache<ListFilesResponse>(buildKey(projectId, 'files', `${directory}:${sortBy}`));
}

export function setCachedFiles(
  projectId: string,
  directory: string,
  sortBy: string,
  data: ListFilesResponse,
): void {
  writeCache(buildKey(projectId, 'files', `${directory}:${sortBy}`), data);
}

export function getCachedDirectories(
  projectId: string,
  parentDirectory: string,
): DirectoryEntry[] | null {
  return readCache<DirectoryEntry[]>(buildKey(projectId, 'dirs', parentDirectory));
}

export function setCachedDirectories(
  projectId: string,
  parentDirectory: string,
  data: DirectoryEntry[],
): void {
  writeCache(buildKey(projectId, 'dirs', parentDirectory), data);
}

export function clearLibraryCache(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(CACHE_PREFIX)) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}
