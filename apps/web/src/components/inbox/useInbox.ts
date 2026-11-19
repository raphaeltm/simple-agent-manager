import type { InboxFilter, InboxItem } from '@simple-agent-manager/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { archiveInboxItem } from '../../lib/api';
import {
  inboxCountQueryOptions,
  inboxItemQueryOptions,
  inboxListQueryOptions,
  inboxQueryKeys,
  projectOverviewQueryKeys,
} from '../../lib/query-options';
import { isRenderableInboxItem } from './inbox-model';

/**
 * Reusable inbox hooks (slice C). A later slice puts "Needs you" on the Project Overview with
 * `useInboxList(projectId, 'needs_you')` and `useInboxCount(projectId)`.
 */

/** Badge counts: `projectId` null counts every project. */
export function useInboxCount(projectId: string | null) {
  const scope = useQueryScope();
  return useQuery(inboxCountQueryOptions(scope, projectId));
}

/** One list, every loaded page flattened. Refetches keep the previous items on screen. */
export function useInboxList(projectId: string | null, filter: InboxFilter, enabled = true) {
  const scope = useQueryScope();
  const query = useInfiniteQuery({
    ...inboxListQueryOptions(scope, projectId, filter),
    enabled: Boolean(scope) && enabled,
  });
  const items = useMemo<InboxItem[]>(() => {
    const seen = new Set<string>();
    const out: InboxItem[] = [];
    for (const page of query.data?.pages ?? []) {
      // A malformed page (proxy error body, API drift) reads as empty instead of crashing the shell.
      const pageItems: unknown = page?.items;
      if (!Array.isArray(pageItems)) continue;
      for (const item of pageItems) {
        if (!isRenderableInboxItem(item)) {
          console.warn('Dropping a malformed inbox row', {
            ref: (item as { ref?: unknown } | null)?.ref,
          });
          continue;
        }
        if (seen.has(item.ref)) continue;
        seen.add(item.ref);
        out.push(item);
      }
    }
    return out;
  }, [query.data]);
  return { ...query, items, loaded: query.data !== undefined };
}

/** One item with its transcript context. */
export function useInboxItem(projectId: string | null, ref: string | null) {
  const scope = useQueryScope();
  return useQuery({
    ...inboxItemQueryOptions(scope, projectId ?? '', ref ?? ''),
    enabled: Boolean(scope && projectId && ref),
  });
}

/**
 * Refetch every inbox list and count (after an answer or an archive), and the Project Overview's
 * read: whether a chat is paused on its person is part of it (Running now's "Paused on this"), so
 * coming back to the Overview after answering must not show the chat still waiting (slice F2).
 */
export function useInvalidateInbox() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  return useCallback(() => {
    if (!scope) return;
    void queryClient.invalidateQueries({ queryKey: inboxQueryKeys.all(scope) });
    void queryClient.invalidateQueries({ queryKey: projectOverviewQueryKeys.all(scope) });
  }, [queryClient, scope]);
}

/**
 * How long an archive can be undone before it is sent. Archive closes the item (a secret request
 * as declined, an approval as denied), so a slip of the thumb must be recoverable. Override with
 * VITE_INBOX_ARCHIVE_UNDO_MS.
 */
const DEFAULT_INBOX_ARCHIVE_UNDO_MS = 5_000;
const configuredUndoMs = Number.parseInt(import.meta.env.VITE_INBOX_ARCHIVE_UNDO_MS ?? '', 10);
export const INBOX_ARCHIVE_UNDO_MS =
  Number.isFinite(configuredUndoMs) && configuredUndoMs >= 0
    ? configuredUndoMs
    : DEFAULT_INBOX_ARCHIVE_UNDO_MS;

interface PendingArchive {
  item: InboxItem;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Archive with an Undo window. `schedule` hides nothing itself: the caller hides the item and
 * shows the receipt. The request is sent when the window ends, when another archive is
 * scheduled, when the page unmounts (navigation), or when the tab is hidden (`visibilitychange`) or
 * closed (`pagehide`), with `keepalive` so a closing tab still delivers it.
 */
export function usePendingArchive({
  onSent,
  onFailed,
}: {
  onSent: (item: InboxItem) => void;
  onFailed: (item: InboxItem, error: unknown) => void;
}) {
  const pendingRef = useRef<PendingArchive | null>(null);
  const [pending, setPending] = useState<InboxItem | null>(null);
  const callbacks = useRef({ onSent, onFailed });
  callbacks.current = { onSent, onFailed };
  const mountedRef = useRef(true);

  const send = useCallback((item: InboxItem, keepalive: boolean) => {
    archiveInboxItem(item.projectId, item.ref, { keepalive }).then(
      () => callbacks.current.onSent(item),
      (error: unknown) => {
        if (mountedRef.current) callbacks.current.onFailed(item, error);
        else console.error('Inbox archive failed after leaving the page', { ref: item.ref, error });
      }
    );
  }, []);

  const flush = useCallback(
    (keepalive: boolean) => {
      const current = pendingRef.current;
      if (!current) return;
      clearTimeout(current.timer);
      pendingRef.current = null;
      if (mountedRef.current) setPending(null);
      send(current.item, keepalive);
    },
    [send]
  );

  const schedule = useCallback(
    (item: InboxItem) => {
      flush(false);
      const timer = setTimeout(() => flush(false), INBOX_ARCHIVE_UNDO_MS);
      pendingRef.current = { item, timer };
      setPending(item);
    },
    [flush]
  );

  /** Cancel the pending archive; returns the item so the caller can show it again. */
  const undo = useCallback((): InboxItem | null => {
    const current = pendingRef.current;
    if (!current) return null;
    clearTimeout(current.timer);
    pendingRef.current = null;
    setPending(null);
    return current.item;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const onPageHide = () => flush(true);
    // A phone may kill a backgrounded tab without a pagehide, so a hidden tab sends it too.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush(true);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      mountedRef.current = false;
      flush(true);
    };
  }, [flush]);

  return { pending, schedule, undo };
}
