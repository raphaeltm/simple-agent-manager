import { useState, useEffect, useRef } from 'react';
import type { DetectedPort } from '@simple-agent-manager/shared';
import { listWorkspacePorts } from '../lib/api';

const POLL_INTERVAL_MS = 10_000;

/**
 * Maximum consecutive fetch failures before clearing the ports list.
 * Keeps stale data visible during transient network hiccups (e.g., token
 * refresh in progress, brief connectivity loss) so the UI doesn't flicker.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export function useWorkspacePorts(
  workspaceUrl: string | undefined,
  workspaceId: string | undefined,
  token: string | undefined,
  isRunning: boolean
) {
  const [ports, setPorts] = useState<DetectedPort[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!workspaceUrl || !workspaceId || !token || !isRunning) {
      setPorts([]);
      consecutiveFailuresRef.current = 0;
      return;
    }

    let cancelled = false;

    async function fetchPorts() {
      try {
        setLoading(true);
        const result = await listWorkspacePorts(workspaceUrl!, workspaceId!, token!);
        if (!cancelled && mountedRef.current) {
          consecutiveFailuresRef.current = 0;
          setPorts(result);
        }
      } catch {
        // Preserve stale ports on transient failures — only clear after
        // MAX_CONSECUTIVE_FAILURES so the UI doesn't flicker on brief hiccups.
        if (!cancelled && mountedRef.current) {
          consecutiveFailuresRef.current += 1;
          if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
            setPorts([]);
          }
        }
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
