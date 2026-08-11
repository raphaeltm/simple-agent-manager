import type { DetectedPort } from '@simple-agent-manager/shared';
import { useEffect, useRef, useState } from 'react';

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

    // Stable non-null bindings for use inside the fetchPorts closure below,
    // where TypeScript does not consistently re-narrow all of the outer
    // `workspaceUrl`/`workspaceId`/`token` locals captured from this compound guard.
    const activeWorkspaceUrl = workspaceUrl;
    const activeWorkspaceId = workspaceId;
    const activeToken = token;

    let cancelled = false;

    async function fetchPorts() {
      try {
        setLoading(true);
        const result = await listWorkspacePorts(activeWorkspaceUrl, activeWorkspaceId, activeToken);
        if (!cancelled && mountedRef.current) {
          consecutiveFailuresRef.current = 0;
          setPorts(result);
        }
      } catch (err) {
        // Preserve stale ports on transient failures — only clear after
        // MAX_CONSECUTIVE_FAILURES so the UI doesn't flicker on brief hiccups.
        if (!cancelled && mountedRef.current) {
          consecutiveFailuresRef.current += 1;
          console.warn('useWorkspacePorts: fetch failed', {
            workspaceId: activeWorkspaceId,
            consecutiveFailures: consecutiveFailuresRef.current,
            error: err instanceof Error ? err.message : String(err),
          });
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
