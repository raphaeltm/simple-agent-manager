import { useQuery } from '@tanstack/react-query';

import { useQueryScope } from '../../../hooks/useQueryScope';
import { getSecretRequest } from '../../../lib/api';
import { projectQueryKeys } from '../../../lib/query-options/projects';

/**
 * How often an open chat card re-reads a request that can still change (answered on another
 * device, or expired). TanStack pauses this while the tab is hidden. Override via
 * VITE_SECRET_REQUEST_CARD_REFRESH_MS.
 */
const DEFAULT_SECRET_REQUEST_CARD_REFRESH_MS = 15_000;
const configuredRefreshMs = Number.parseInt(
  import.meta.env.VITE_SECRET_REQUEST_CARD_REFRESH_MS ?? '',
  10
);
const SECRET_REQUEST_CARD_REFRESH_MS =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs > 0
    ? configuredRefreshMs
    : DEFAULT_SECRET_REQUEST_CARD_REFRESH_MS;

/**
 * One secret request (metadata only, never a value), shared by the chat card and the inbox so an
 * answer in either refreshes both. `refreshWhilePending` re-reads it while it is still open (the
 * chat card); the inbox relies on its own stale check instead.
 */
export function useSecretRequest(
  projectId: string | undefined,
  requestId: string | null | undefined,
  { refreshWhilePending = false }: { refreshWhilePending?: boolean } = {}
) {
  const scope = useQueryScope();
  const queryKey = projectQueryKeys.secretRequest(scope, projectId ?? '', requestId ?? '');
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getSecretRequest(projectId as string, requestId as string, signal),
    enabled: Boolean(scope && projectId && requestId),
    retry: false,
    refetchInterval: (q) =>
      !refreshWhilePending ||
      q.state.data?.request.status !== 'pending' ||
      (q.state.error && !q.state.data)
        ? false
        : SECRET_REQUEST_CARD_REFRESH_MS,
  });
  return { query, queryKey, scope };
}
