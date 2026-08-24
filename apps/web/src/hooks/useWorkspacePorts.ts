import type { DetectedPort } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { WORKSPACE_PORTS_POLL_MS } from '../lib/poll-intervals';
import { workspacePortsQueryOptions } from '../lib/query-options';
import { useQueryScope } from './useQueryScope';

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
  const queryScope = useQueryScope();
  const enabled = Boolean(workspaceUrl && workspaceId && token && isRunning && queryScope);
  const lastLoggedErrorAtRef = useRef(0);
  const lastSuccessAtRef = useRef(0);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);

  const query = useQuery({
    ...workspacePortsQueryOptions(queryScope, workspaceUrl ?? '', workspaceId ?? '', token ?? ''),
    enabled,
    refetchInterval: WORKSPACE_PORTS_POLL_MS > 0 ? WORKSPACE_PORTS_POLL_MS : false,
  });

  useEffect(() => {
    if (!query.error || query.errorUpdatedAt === 0) return;
    if (query.errorUpdatedAt === lastLoggedErrorAtRef.current) return;
    lastLoggedErrorAtRef.current = query.errorUpdatedAt;
    setConsecutiveFailures((previous) => {
      const next = previous + 1;
      console.warn('useWorkspacePorts: fetch failed', {
        workspaceId,
        consecutiveFailures: next,
        error: query.error instanceof Error ? query.error.message : String(query.error),
      });
      return next;
    });
  }, [query.error, query.errorUpdatedAt, workspaceId]);

  useEffect(() => {
    if (query.dataUpdatedAt === 0) return;
    if (query.dataUpdatedAt === lastSuccessAtRef.current) return;
    lastSuccessAtRef.current = query.dataUpdatedAt;
    setConsecutiveFailures(0);
  }, [query.dataUpdatedAt]);

  const ports: DetectedPort[] =
    !enabled || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? [] : (query.data ?? []);

  return {
    ports,
    loading: enabled && query.isPending && query.data === undefined,
  };
}
