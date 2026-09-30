import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { type AcpInteractionSnapshotItem, listAcpInteractions } from '../lib/api/acp-interactions';
import { ApiClientError } from '../lib/api/client';
import {
  ACP_PERMISSION_POLL_MS,
  ACP_PERMISSION_QUERY_RETRY_COUNT,
  ACP_PERMISSION_RECOVERY_POLL_MS,
} from '../lib/poll-intervals';

function isAuthorizationError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && (error.status === 401 || error.status === 403);
}

export function useAcpPermissionInteractions({
  projectId,
  sessionId,
  viewerId,
  connectionState,
  refreshSignal,
}: {
  projectId: string;
  sessionId: string;
  viewerId: string | null;
  connectionState: string;
  refreshSignal?: string | null;
}) {
  const previousConnectionState = useRef(connectionState);
  const previousRefreshSignal = useRef(refreshSignal);
  const query = useQuery({
    queryKey: ['acp-permission-interactions', viewerId, projectId, sessionId],
    queryFn: () => listAcpInteractions(projectId, sessionId),
    enabled: Boolean(projectId && sessionId && viewerId),
    retry: (failureCount, error) =>
      !isAuthorizationError(error) && failureCount < ACP_PERMISSION_QUERY_RETRY_COUNT,
    refetchInterval: (current) => {
      if (isAuthorizationError(current.state.error)) return false;
      return (current.state.data?.pending?.length ?? 0) > 0
        ? ACP_PERMISSION_POLL_MS
        : ACP_PERMISSION_RECOVERY_POLL_MS;
    },
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const reconnected =
      previousConnectionState.current !== 'connected' && connectionState === 'connected';
    previousConnectionState.current = connectionState;
    if (reconnected) void query.refetch();
  }, [connectionState, query.refetch]);

  useEffect(() => {
    const changed = previousRefreshSignal.current !== refreshSignal;
    previousRefreshSignal.current = refreshSignal;
    if (changed) void query.refetch();
  }, [query.refetch, refreshSignal]);

  const authorizationError = isAuthorizationError(query.error);

  const interactions = useMemo<AcpInteractionSnapshotItem[]>(() => {
    // TanStack intentionally retains prior data after a failed background refetch.
    // Authorization failures must fail closed so mounted cards immediately drop their
    // transient decrypted detail instead of continuing to render that retained snapshot.
    if (authorizationError || !query.data) return [];
    const pending = Array.isArray(query.data.pending) ? query.data.pending : [];
    const settled = Array.isArray(query.data.settled) ? query.data.settled : [];
    return [...pending, ...settled].filter((interaction) => interaction.kind === 'permission');
  }, [authorizationError, query.data]);

  return {
    interactions,
    loading: query.isLoading,
    error: query.error,
    authorizationError,
    refresh: query.refetch,
  };
}
