import {
  type DirectoryEntry,
  LIBRARY_DEFAULTS,
  type ListFilesResponse,
  type ProjectFile,
  type ProjectFileTag,
} from '@simple-agent-manager/shared';

const CACHE_PREFIX = 'sam-library:';

/** Cache TTL (ms). Overridable via VITE_LIBRARY_CACHE_TTL_MS for self-hosters. */
const CACHE_TTL_MS = (() => {
  const raw = import.meta.env?.VITE_LIBRARY_CACHE_TTL_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LIBRARY_DEFAULTS.CLIENT_CACHE_TTL_MS;
})();

/**
 * Approximate ceiling for a single cached value (UTF-16 chars). Above this we
 * skip the write entirely rather than thrash localStorage. Overridable via
 * VITE_LIBRARY_INDEX_MAX_CACHE_CHARS for self-hosters with larger quotas.
 */
const INDEX_MAX_CACHE_CHARS = (() => {
  const raw = import.meta.env?.VITE_LIBRARY_INDEX_MAX_CACHE_CHARS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 1024 * 1024; // ~2M chars
})();

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/** A swept, client-side index of all files in a project (sub-cap projects only). */
export type CachedIndexFile = ProjectFile & { tags: ProjectFileTag[] };

export interface CachedLibraryIndex {
  files: CachedIndexFile[];
  count: number;
  sweptAt: number;
}

function buildKey(projectId: string, type: 'files' | 'dirs', params: string): string {
  return `${CACHE_PREFIX}${projectId}:${type}:${params}`;
}

function buildIndexKey(projectId: string): string {
  return `${CACHE_PREFIX}${projectId}:global-index`;
}

/** Best-effort timestamp extraction for LRU eviction across mixed entry shapes. */
function entryTimestamp(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as { timestamp?: number; sweptAt?: number };
    return parsed.sweptAt ?? parsed.timestamp ?? 0;
  } catch {
    return 0;
  }
}

/** Find the oldest `sam-library:*` key by timestamp, excluding `exceptKey`. */
function findOldestLibraryKey(exceptKey: string): string | null {
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(CACHE_PREFIX) || key === exceptKey) continue;
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    const ts = entryTimestamp(raw);
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestKey = key;
    }
  }
  return oldestKey;
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

/** Max LRU evictions on a quota error. Overridable via VITE_LIBRARY_CACHE_MAX_EVICTIONS. */
const MAX_EVICTIONS = (() => {
  const raw = import.meta.env?.VITE_LIBRARY_CACHE_MAX_EVICTIONS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : LIBRARY_DEFAULTS.CLIENT_CACHE_MAX_EVICTIONS;
})();

/**
 * Write to localStorage with a size guard and LRU eviction. Returns true if the
 * write succeeded. Skips oversized values outright; on quota errors, evicts the
 * oldest `sam-library:*` entry and retries (bounded). Never throws, never loops
 * forever — a persistent quota failure simply returns false (no re-sweep storm).
 */
function safeSetItem(key: string, serialized: string): boolean {
  if (serialized.length + key.length > INDEX_MAX_CACHE_CHARS) {
    return false;
  }
  for (let attempt = 0; attempt <= MAX_EVICTIONS; attempt++) {
    try {
      localStorage.setItem(key, serialized);
      return true;
    } catch {
      const victim = findOldestLibraryKey(key);
      if (!victim) return false;
      try {
        localStorage.removeItem(victim);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function writeCache<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now() };
    safeSetItem(key, JSON.stringify(entry));
  } catch {
    // serialization failure — silently ignore
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

// -----------------------------------------------------------------------------
// Global client-side index (sub-cap projects) — distinct from per-directory keys
// -----------------------------------------------------------------------------

export function getCachedIndex(projectId: string): CachedLibraryIndex | null {
  try {
    const raw = localStorage.getItem(buildIndexKey(projectId));
    if (!raw) return null;
    const index = JSON.parse(raw) as CachedLibraryIndex;
    if (Date.now() - index.sweptAt > CACHE_TTL_MS) {
      localStorage.removeItem(buildIndexKey(projectId));
      return null;
    }
    return index;
  } catch {
    return null;
  }
}

/** Persist the swept index. Returns false if skipped (oversized or quota-bound). */
export function setCachedIndex(projectId: string, files: CachedIndexFile[]): boolean {
  const index: CachedLibraryIndex = { files, count: files.length, sweptAt: Date.now() };
  try {
    return safeSetItem(buildIndexKey(projectId), JSON.stringify(index));
  } catch {
    return false;
  }
}

export function clearCachedIndex(projectId: string): void {
  try {
    localStorage.removeItem(buildIndexKey(projectId));
  } catch {
    // ignore
  }
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
