import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { type AcpInteractionSnapshotItem, listAcpInteractions } from '../lib/api/acp-interactions';
import { ACP_PERMISSION_POLL_MS } from '../lib/poll-intervals';

export function useAcpPermissionInteractions({
  projectId,
  sessionId,
  viewerId,
  connectionState,
}: {
  projectId: string;
  sessionId: string;
  viewerId: string | null;
  connectionState: string;
}) {
  const previousConnectionState = useRef(connectionState);
  const query = useQuery({
    queryKey: ['acp-permission-interactions', viewerId, projectId, sessionId],
    queryFn: () => listAcpInteractions(projectId, sessionId),
    enabled: Boolean(projectId && sessionId && viewerId),
    refetchInterval: (current) =>
      (current.state.data?.pending?.length ?? 0) > 0 ? ACP_PERMISSION_POLL_MS : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    const reconnected =
      previousConnectionState.current !== 'connected' && connectionState === 'connected';
    previousConnectionState.current = connectionState;
    if (reconnected) void query.refetch();
  }, [connectionState, query.refetch]);

  const interactions = useMemo<AcpInteractionSnapshotItem[]>(() => {
    if (!query.data) return [];
    const pending = Array.isArray(query.data.pending) ? query.data.pending : [];
    const settled = Array.isArray(query.data.settled) ? query.data.settled : [];
    return [...pending, ...settled].filter(
      (interaction) => interaction.kind === 'permission'
    );
  }, [query.data]);

  return {
    interactions,
    loading: query.isLoading,
    error: query.error,
    refresh: query.refetch,
  };
}
