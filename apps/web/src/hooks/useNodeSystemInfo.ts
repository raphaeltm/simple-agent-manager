import { useState, useEffect, useRef } from 'react';
import type { NodeSystemInfo } from '@simple-agent-manager/shared';
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
  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!nodeId || nodeStatus !== 'running') {
      setSystemInfo(null);
      setError(null);
      hasLoadedRef.current = false;
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchInfo = async () => {
      if (hasLoadedRef.current) {
        setIsRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const data = await getNodeSystemInfo(nodeId);
        if (mountedRef.current) {
          setSystemInfo(data);
          setError(null);
          hasLoadedRef.current = true;
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load system info');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setIsRefreshing(false);
        }
      }
    };

    fetchInfo();
    intervalId = setInterval(fetchInfo, POLL_INTERVAL_MS);

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [nodeId, nodeStatus]);

  return { systemInfo, loading, isRefreshing, error };
}
