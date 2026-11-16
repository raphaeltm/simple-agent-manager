/**
 * The Project Overview's data: one aggregated read (`projectOverviewQueryOptions`), kept fresh
 * by the project socket's session events, plus the tasks this page just started.
 *
 * A started task is shown in Running now at once and stays until the read includes it. The
 * read comes from the chat index the ProjectData object keeps in sync, so for a moment after a
 * start it may not have the new chat yet; the local row covers that gap and expires after
 * `OVERVIEW_PENDING_START_TTL_MS` so a start the server never shows cannot linger.
 */
import type { OverviewRunningChat, ProjectOverviewResponse } from '@simple-agent-manager/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useProjectWebSocket } from '../../hooks/useProjectWebSocket';
import { useQueryScope } from '../../hooks/useQueryScope';
import { projectOverviewQueryKeys, projectOverviewQueryOptions } from '../../lib/query-options';

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long a just-started task is shown before the read must include it. */
export const DEFAULT_OVERVIEW_PENDING_START_TTL_MS = 120_000;
export const OVERVIEW_PENDING_START_TTL_MS = positiveInt(
  import.meta.env.VITE_OVERVIEW_PENDING_START_TTL_MS,
  DEFAULT_OVERVIEW_PENDING_START_TTL_MS
);

/** Session events arrive in bursts (activity, completion, attention); refetch once per burst. */
export const DEFAULT_OVERVIEW_EVENT_REFRESH_MS = 1_500;
export const OVERVIEW_EVENT_REFRESH_MS = positiveInt(
  import.meta.env.VITE_OVERVIEW_EVENT_REFRESH_MS,
  DEFAULT_OVERVIEW_EVENT_REFRESH_MS
);

export interface PendingStart {
  chat: OverviewRunningChat;
  addedAt: number;
}

export function useProjectOverview(projectId: string) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const query = useQuery({
    ...projectOverviewQueryOptions(queryScope, projectId),
    enabled: Boolean(queryScope && projectId),
  });

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: projectOverviewQueryKeys.detail(queryScope, projectId),
    });
  }, [queryClient, queryScope, projectId]);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      refresh();
    }, OVERVIEW_EVENT_REFRESH_MS);
  }, [refresh]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  useProjectWebSocket({
    projectId,
    onSessionEvent: scheduleRefresh,
    onReconnected: refresh,
  });

  const [pending, setPending] = useState<PendingStart[]>([]);
  const addPendingStart = useCallback(
    (chat: OverviewRunningChat) => {
      setPending((current) => [
        { chat, addedAt: Date.now() },
        ...current.filter((entry) => entry.chat.sessionId !== chat.sessionId),
      ]);
      refresh();
    },
    [refresh]
  );

  const data = query.data;
  const running = useMemo(() => mergeRunning(data, pending, Date.now()), [data, pending]);

  // Drop pending rows the read now includes, or that outlived their TTL.
  useEffect(() => {
    if (pending.length === 0) return;
    const now = Date.now();
    const shown = new Set(data?.running.items.map((item) => item.sessionId));
    const keep = pending.filter(
      (entry) =>
        !shown.has(entry.chat.sessionId) && now - entry.addedAt < OVERVIEW_PENDING_START_TTL_MS
    );
    if (keep.length !== pending.length) setPending(keep);
  }, [data, pending]);

  return {
    data,
    running,
    isPending: query.isPending,
    isError: query.isError && !data,
    addPendingStart,
    refresh,
  };
}

/** Running now: just-started tasks first, then the read's rows, counted once each. */
export function mergeRunning(
  data: ProjectOverviewResponse | undefined,
  pending: readonly PendingStart[],
  now: number
): { items: OverviewRunningChat[]; total: number } {
  const server = data?.running.items ?? [];
  const shown = new Set(server.map((item) => item.sessionId));
  const extra = pending
    .filter(
      (entry) =>
        !shown.has(entry.chat.sessionId) && now - entry.addedAt < OVERVIEW_PENDING_START_TTL_MS
    )
    .map((entry) => entry.chat);
  return { items: [...extra, ...server], total: (data?.running.total ?? 0) + extra.length };
}
