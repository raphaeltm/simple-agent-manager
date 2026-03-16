import { useState, useEffect, useRef } from 'react';
import type { DetectedPort } from '@simple-agent-manager/shared';
import { listWorkspacePorts } from '../lib/api';

const POLL_INTERVAL_MS = 10_000;

export function useWorkspacePorts(
  workspaceUrl: string | undefined,
  workspaceId: string | undefined,
  token: string | undefined,
  isRunning: boolean
) {
  const [ports, setPorts] = useState<DetectedPort[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceUrl || !workspaceId || !token || !isRunning) {
      setPorts([]);
      return;
    }

    let cancelled = false;

    async function fetchPorts() {
      try {
        setLoading(true);
        const result = await listWorkspacePorts(workspaceUrl!, workspaceId!, token!);
        if (!cancelled && mountedRef.current) {
          setPorts(result);
        }
      } catch {
        // Silently ignore — ports are best-effort UX
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    }

    fetchPorts();
    const interval = setInterval(fetchPorts, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspaceUrl, workspaceId, token, isRunning]);

  return { ports, loading };
}
