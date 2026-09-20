/**
 * Local stand-in for the panel's `useQuery` call.
 *
 * Produces exactly the props `ResourceHistoryContent` takes, so the variants can
 * render the real component unchanged. Chunk selection resolves after a short
 * delay so the "Loading detail…" state is reachable, which is the one piece of
 * behaviour a synchronous mock would hide.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { WorkspaceResourceHistoryResponse } from '../../lib/api/sessions';
import { getDataset, type PrototypeDatasetId } from './mock-data';

/** Simulated round-trip for a chunk detail fetch. */
export const DETAIL_FETCH_DELAY_MS = 400;

export interface ResourceDatasetView {
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  history: WorkspaceResourceHistoryResponse | undefined;
  summary: WorkspaceResourceHistoryResponse['summary'];
  detail: WorkspaceResourceHistoryResponse['detail'];
  /** Chunk the detail belongs to, defaulting to the newest chunk. */
  effectiveChunkId: string | null;
  selectChunk: (chunkId: string) => void;
}

export function useResourceDataset(
  datasetId: PrototypeDatasetId,
  options: { autoLoadDetail?: boolean } = {}
): ResourceDatasetView {
  const { autoLoadDetail = false } = options;
  const dataset = getDataset(datasetId);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null);
  const [loadedChunkId, setLoadedChunkId] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latestChunkId = dataset.history.chunks[0]?.id ?? null;
  const effectiveChunkId = selectedChunkId ?? latestChunkId;

  // Switching dataset invalidates any in-flight or loaded detail.
  useEffect(() => {
    setSelectedChunkId(null);
    setLoadedChunkId(null);
    setIsFetching(false);
    if (timer.current) clearTimeout(timer.current);
  }, [datasetId]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const selectChunk = useCallback((chunkId: string) => {
    setSelectedChunkId(chunkId);
    setIsFetching(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLoadedChunkId(chunkId);
      setIsFetching(false);
    }, DETAIL_FETCH_DELAY_MS);
  }, []);

  // Variant C is chart-first, so it cannot wait for a tap to have a chart.
  useEffect(() => {
    if (!autoLoadDetail || !latestChunkId) return;
    selectChunk(latestChunkId);
  }, [autoLoadDetail, latestChunkId, selectChunk]);

  const detail = useMemo(
    () => (loadedChunkId ? dataset.detailFor(loadedChunkId) : undefined),
    [dataset, loadedChunkId]
  );

  return {
    isLoading: false,
    isError: dataset.isError,
    isFetching,
    history: dataset.isError ? undefined : dataset.history,
    summary: dataset.isError ? null : dataset.history.summary,
    detail,
    effectiveChunkId,
    selectChunk,
  };
}
