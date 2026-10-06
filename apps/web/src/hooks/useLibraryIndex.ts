// =============================================================================
// useLibraryIndex — client-side library sweep + index acquisition
// =============================================================================
//
// Acquisition only. Sweeps the entire project library (sub-cap projects) into a
// client-side set, hydrates from TanStack Query cache for flicker-free first
// paint, and exposes a targeted invalidation handle for mutations. Matching and
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import type { FileWithTags } from '../components/library/types';
import { buildIndex, type LibraryIndex } from '../lib/library-search';
import { libraryIndexQueryOptions, libraryQueryKeys } from '../lib/query-options';
import { useQueryScope } from './useQueryScope';

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

export function useLibraryIndex(
  projectId: string,
  cacheNamespace?: string | null
): UseLibraryIndexResult {
  const cap = resolveCap();
  const maxSweepPages = resolveMaxSweepPages();
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const queryConfig = useMemo(
    () => ({ cap, maxSweepPages, namespace: cacheNamespace ?? null }),
    [cacheNamespace, cap, maxSweepPages]
  );

  const query = useQuery({
    ...libraryIndexQueryOptions(queryScope, projectId, queryConfig),
    enabled: Boolean(projectId && queryScope),
  });

  const invalidate = useCallback(() => {
    if (!projectId || !queryScope) return;
    void queryClient.invalidateQueries({
      queryKey: libraryQueryKeys.index(queryScope, projectId, queryConfig),
    });
  }, [projectId, queryClient, queryConfig, queryScope]);

  const files = (query.data?.files ?? []) as FileWithTags[];
  const status: LibraryIndexStatus =
    query.data?.status ?? (query.error && query.data === undefined ? 'error' : 'loading');

  const index = useMemo(() => buildIndex(files), [files]);

  return {
    files,
    index,
    status,
    isSweeping: query.isFetching,
    sweepError: Boolean(query.error),
    fileCount: query.data?.fileCount ?? 0,
    invalidate,
  };
}
