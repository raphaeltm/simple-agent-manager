import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { PROJECT_PREFETCH_DELAY_MS } from '../lib/project-query-config';
import { projectDetailQueryOptions } from '../lib/query-options';

export function useProjectIntentPrefetch(queryScope: string) {
  const queryClient = useQueryClient();
  const hoverTimerRef = useRef<number | null>(null);

  const cancelHoverPrefetch = useCallback(() => {
    if (hoverTimerRef.current === null) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  }, []);

  const prefetchProject = useCallback((projectId: string) => {
    if (!queryScope) return;
    void queryClient.prefetchQuery(projectDetailQueryOptions(queryScope, projectId));
  }, [queryClient, queryScope]);

  const scheduleHoverPrefetch = useCallback((projectId: string) => {
    cancelHoverPrefetch();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      prefetchProject(projectId);
    }, PROJECT_PREFETCH_DELAY_MS);
  }, [cancelHoverPrefetch, prefetchProject]);

  useEffect(() => cancelHoverPrefetch, [cancelHoverPrefetch]);

  return { cancelHoverPrefetch, prefetchProject, scheduleHoverPrefetch };
}
