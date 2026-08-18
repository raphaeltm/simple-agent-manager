import type { DetectedPort } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { listWorkspacePorts } from '../lib/api';
import { WORKSPACE_PORTS_POLL_MS } from '../lib/poll-intervals';
import { useVisibilityAwarePoll } from './useVisibilityAwarePoll';

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

  // Monotonic generation, bumped whenever the target workspace/token changes.
  // Replaces the previous effect-scoped `cancelled` flag: a response from a
  // superseded parameter set must never write into state.
  const generationRef = useRef(0);
  const hasLoadedRef = useRef(false);

  const enabled = Boolean(workspaceUrl && workspaceId && token && isRunning);

  const fetchPorts = useCallback(async () => {
    // Stable non-null bindings — TypeScript does not consistently re-narrow the
    // outer optional params inside the async body below.
    const activeWorkspaceUrl = workspaceUrl;
    const activeWorkspaceId = workspaceId;
    const activeToken = token;
    if (!activeWorkspaceUrl || !activeWorkspaceId || !activeToken) return;

    const generation = generationRef.current;
    const isCurrent = () => generation === generationRef.current && mountedRef.current;

    try {
      // Only the very first load may gate rendering — background polls must not
      // flip a consumer back into a loading state and hide already-rendered
      // ports (`.claude/rules/48-stale-while-revalidate-ui.md`). Mirrors the
      // `hasLoadedRef` handling in useNodeSystemInfo.
      if (!hasLoadedRef.current) setLoading(true);
      const result = await listWorkspacePorts(activeWorkspaceUrl, activeWorkspaceId, activeToken);
      if (isCurrent()) {
        consecutiveFailuresRef.current = 0;
        setPorts(result);
      }
    } catch (err) {
      // Preserve stale ports on transient failures — only clear after
      // MAX_CONSECUTIVE_FAILURES so the UI doesn't flicker on brief hiccups.
      if (isCurrent()) {
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
        hasLoadedRef.current = true;
        setLoading(false);
      }
    }
  }, [workspaceUrl, workspaceId, token]);

  useEffect(() => {
    // Invalidate any in-flight request issued for the previous parameter set.
    generationRef.current += 1;
    if (!enabled) {
      setPorts([]);
      consecutiveFailuresRef.current = 0;
      hasLoadedRef.current = false;
      return;
    }
    // A different workspace/token is a different dataset — the next load gates
    // rendering again rather than showing the previous workspace's ports.
    hasLoadedRef.current = false;
    void fetchPorts();
  }, [enabled, fetchPorts]);

  // Paused on hidden tabs; refreshes immediately on return if stale.
  useVisibilityAwarePoll(fetchPorts, WORKSPACE_PORTS_POLL_MS, { enabled });

  return { ports, loading };
}
