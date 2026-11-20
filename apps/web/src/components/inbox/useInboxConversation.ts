import type { InboxConversation } from '@simple-agent-manager/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { inboxConversationQueryOptions } from '../../lib/query-options';
import { conversationEntries, nextConversationCursor } from './inbox-conversation-model';

/**
 * Pages read on their own to reach the newest agent response. Response pages run oldest first,
 * so an item with more responses than one page would otherwise put its answer buttons on an old
 * response. Override with VITE_INBOX_RESPONSE_AUTO_PAGES.
 */
const DEFAULT_INBOX_RESPONSE_AUTO_PAGES = 10;
const configuredAutoPages = Number.parseInt(
  import.meta.env.VITE_INBOX_RESPONSE_AUTO_PAGES ?? '',
  10
);
const INBOX_RESPONSE_AUTO_PAGES =
  Number.isFinite(configuredAutoPages) && configuredAutoPages >= 0
    ? configuredAutoPages
    : DEFAULT_INBOX_RESPONSE_AUTO_PAGES;

/**
 * An item's conversation: the first page comes with the item read (`first`). When that page has
 * later responses, they are read straight away (bounded); older replies are read when the person
 * asks for more. Background refetches keep the merged turns on screen.
 */
export function useInboxConversation({
  projectId,
  itemRef,
  first,
}: {
  projectId: string;
  itemRef: string;
  first: InboxConversation | null;
}) {
  const scope = useQueryScope();
  // Per item: the walk keys the item pane by ref, so a new item starts collapsed.
  const [wantMore, setWantMore] = useState(false);
  const from = nextConversationCursor(first);
  const followResponses =
    typeof first?.nextResponseCursor === 'number' && INBOX_RESPONSE_AUTO_PAGES > 0;
  const reading = wantMore || followResponses;
  const more = useInfiniteQuery({
    ...inboxConversationQueryOptions(scope, projectId, itemRef, from ?? {}, nextConversationCursor),
    enabled: Boolean(scope) && reading && from !== null,
  });
  const pages = more.data?.pages;
  const lastPage = pages?.[pages.length - 1];
  const responsesPending =
    followResponses &&
    (pages === undefined ||
      (typeof lastPage?.nextResponseCursor === 'number' &&
        pages.length < INBOX_RESPONSE_AUTO_PAGES));
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = more;
  useEffect(() => {
    if (responsesPending && pages !== undefined && hasNextPage && !isFetchingNextPage && !isError)
      void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isError, isFetchingNextPage, pages, responsesPending]);
  const entries = useMemo(() => conversationEntries([first, ...(pages ?? [])]), [first, pages]);
  const hasMore = from !== null && (!reading || isError || hasNextPage === true);
  const loadMore = () => {
    if (!wantMore) setWantMore(true);
    if (isError) void more.refetch();
    else if (reading && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  };
  return {
    entries,
    hasMore,
    loadingMore: reading && (more.isLoading || isFetchingNextPage),
    loadError: more.error,
    loadMore,
    /** The newest response is known: no automatic page is still being read. */
    settled: first !== null && !(responsesPending && !isError),
  };
}
