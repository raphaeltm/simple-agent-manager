import type { NodeSystemInfo } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getNodeSystemInfo } from '../lib/api';
import { NODE_SYSTEM_INFO_POLL_MS } from '../lib/poll-intervals';
import { useVisibilityAwarePoll } from './useVisibilityAwarePoll';

export function useNodeSystemInfo(
  nodeId: string | undefined,
  nodeStatus: string | undefined
) {
  const [systemInfo, setSystemInfo] = useState<NodeSystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isPollable = Boolean(nodeId) && nodeStatus === 'running';

  // `loading` (which gates the first render) is only set before the very first
  // load; subsequent polls set `isRefreshing`, keeping already-rendered data on
  // screen per `.claude/rules/48-stale-while-revalidate-ui.md`.
  const fetchInfo = useCallback(async () => {
    if (!nodeId) return;
    // Matches the generation guard in useWorkspacePorts: switching from node A
    // to node B must not let A's slower in-flight response land under B's
    // identity.
    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && mountedRef.current;

    if (hasLoadedRef.current) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const data = await getNodeSystemInfo(nodeId);
      if (isCurrent()) {
        setSystemInfo(data);
        setError(null);
      }
    } catch (err) {
      if (isCurrent()) {
        setError(err instanceof Error ? err.message : 'Failed to load system info');
      }
    } finally {
      if (mountedRef.current) {
        hasLoadedRef.current = true;
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [nodeId]);

  useEffect(() => {
    // Invalidate any response still in flight for the previous node.
    generationRef.current += 1;
    if (!isPollable) {
      setSystemInfo(null);
      setError(null);
      hasLoadedRef.current = false;
      return;
    }
    hasLoadedRef.current = false;
    void fetchInfo();
  }, [isPollable, fetchInfo]);

  // Paused on hidden tabs; refreshes immediately on return if stale.
  useVisibilityAwarePoll(fetchInfo, NODE_SYSTEM_INFO_POLL_MS, { enabled: isPollable });

  return { systemInfo, loading, isRefreshing, error };
}
