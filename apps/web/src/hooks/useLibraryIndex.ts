// =============================================================================
// useLibraryIndex — client-side library sweep + index acquisition
// =============================================================================
//
// Acquisition only. Sweeps the entire project library (sub-cap projects) into a
// client-side set, hydrates from localStorage for flicker-free first paint, and
// exposes a generation-guarded invalidation handle for mutations. Matching and
// ranking live in lib/library-search.ts — this hook never filters.
//
// Sweep contract (see tasks/.../library-client-index-search.md):
//   - request directory='/' with recursive=true so the index covers folders.
//   - sortOrder MUST be 'asc' (cursor is `id > cursor` ascending ULID; 'desc'
//     would drop/dupe rows that share a createdAt millisecond).
//   - loop until cursor === null (NOT count-based), bounded by MAX_SWEEP_PAGES.
//   - strip extractedTextPreview before caching (keeps the index small).
//   - if total >= cap, abort and report 'overCap' so the caller falls back to
//     the server-search path.

import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FileWithTags } from '../components/library/types';
import { listLibraryFiles } from '../lib/api/library';
import {
  type CachedIndexFile,
  clearCachedIndex,
  getCachedIndex,
  setCachedIndex,
} from '../lib/library-cache';
import { buildIndex, type LibraryIndex } from '../lib/library-search';

/** Safety cap on sweep iterations (200/page × 10 = 2000, far above the file cap). */
function resolveMaxSweepPages(): number {
  const raw = import.meta.env?.VITE_LIBRARY_CLIENT_MAX_SWEEP_PAGES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LIBRARY_DEFAULTS.CLIENT_MAX_SWEEP_PAGES;
}

export type LibraryIndexStatus = 'loading' | 'ready' | 'overCap' | 'error';

export interface UseLibraryIndexResult {
  /** All swept files (sub-cap projects). Empty when overCap/loading/error. */
  files: FileWithTags[];
  /** Search index built from `files`. */
  index: LibraryIndex;
  status: LibraryIndexStatus;
  /** Background re-sweep in progress (does not blank the view). */
  isSweeping: boolean;
  /** A sweep page failed mid-flight; show a non-blocking retry banner. */
  sweepError: boolean;
  /** Server-reported total file count (authoritative for the cap decision). */
  fileCount: number;
  /** Bump the sweep generation → trailing re-sweep. Call after every mutation. */
  invalidate: () => void;
}

function resolveCap(): number {
  const raw = import.meta.env?.VITE_LIBRARY_CLIENT_SWEEP_CAP;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LIBRARY_DEFAULTS.CLIENT_SWEEP_CAP;
}

/** Remove the (potentially large) extracted-text preview before caching. */
function stripPreview(file: FileWithTags): CachedIndexFile {
  return { ...file, extractedTextPreview: null };
}

export function useLibraryIndex(projectId: string): UseLibraryIndexResult {
  const cap = resolveCap();
  const maxSweepPages = resolveMaxSweepPages();
  const [files, setFiles] = useState<FileWithTags[]>([]);
  const [status, setStatus] = useState<LibraryIndexStatus>('loading');
  const [isSweeping, setIsSweeping] = useState(false);
  const [sweepError, setSweepError] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [invalidationToken, setInvalidationToken] = useState(0);

  const genRef = useRef(0);
  const filesRef = useRef<FileWithTags[]>([]);
  filesRef.current = files;

  const invalidate = useCallback(() => setInvalidationToken((t) => t + 1), []);

  useEffect(() => {
    const gen = ++genRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && gen === genRef.current;

    // Hydrate from cache for a flicker-free first paint, then re-sweep.
    const cached = getCachedIndex(projectId);
    if (cached) {
      setFiles(cached.files);
      setFileCount(cached.count);
      setStatus('ready');
    } else {
      setFiles([]);
      setStatus('loading');
    }
    const hadCache = !!cached;

    async function sweep() {
      setIsSweeping(true);
      setSweepError(false);
      const accumulated: CachedIndexFile[] = [];
      let cursor: string | undefined;
      let pages = 0;

      try {
        for (;;) {
          const resp = await listLibraryFiles(projectId, {
            directory: '/',
            recursive: true,
            sortBy: 'createdAt',
            sortOrder: 'asc',
            limit: LIBRARY_DEFAULTS.LIST_MAX_PAGE_SIZE,
            cursor,
          });
          if (!isCurrent()) return;

          if (resp.total >= cap) {
            setFiles([]);
            setFileCount(resp.total);
            setStatus('overCap');
            clearCachedIndex(projectId);
            return;
          }

          for (const file of resp.files) accumulated.push(stripPreview(file));
          pages += 1;

          // First page with no cache: paint immediately, keep accumulating.
          if (pages === 1 && !hadCache) {
            setFiles([...accumulated]);
            setStatus('ready');
          }

          if (resp.cursor === null || pages >= maxSweepPages) break;
          cursor = resp.cursor;
        }

        if (!isCurrent()) return;
        setFiles(accumulated);
        setFileCount(accumulated.length);
        setStatus('ready');
        setCachedIndex(projectId, accumulated);
      } catch {
        if (!isCurrent()) return;
        setSweepError(true);
        // Keep whatever we already showed; only hard-fail if we have nothing.
        if (accumulated.length === 0 && filesRef.current.length === 0) {
          setStatus('error');
        } else {
          setStatus('ready');
        }
      } finally {
        if (isCurrent()) setIsSweeping(false);
      }
    }

    void sweep();
    return () => {
      cancelled = true;
    };
    // Sweep ONLY on project change or explicit invalidation — never on
    // directory navigation, search, or sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, invalidationToken]);

  const index = useMemo(() => buildIndex(files), [files]);

  return { files, index, status, isSweeping, sweepError, fileCount, invalidate };
}
