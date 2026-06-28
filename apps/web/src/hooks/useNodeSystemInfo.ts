import type { NodeSystemInfo } from '@simple-agent-manager/shared';
import { useEffect, useRef, useState } from 'react';

import { getNodeSystemInfo } from '../lib/api';

const POLL_INTERVAL_MS = 10_000;

export function useNodeSystemInfo(
  nodeId: string | undefined,
  nodeStatus: string | undefined
) {
  const [systemInfo, setSystemInfo] = useState<NodeSystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    if (!nodeId || nodeStatus !== 'running') {
      setSystemInfo(null);
      setError(null);
      hasLoadedRef.current = false;
      return;
    }

    let cancelled = false;

    const fetchInfo = async () => {
      if (hasLoadedRef.current) {
        setIsRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const data = await getNodeSystemInfo(nodeId);
        if (!cancelled) {
          setSystemInfo(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load system info');
        }
      } finally {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    hasLoadedRef.current = false;
    fetchInfo();
    const intervalId = setInterval(fetchInfo, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [nodeId, nodeStatus]);

  return { systemInfo, loading, isRefreshing, error };
}
