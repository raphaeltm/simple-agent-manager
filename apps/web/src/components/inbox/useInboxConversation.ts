import type { InboxConversation } from '@simple-agent-manager/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { inboxConversationQueryOptions } from '../../lib/query-options';
import { conversationEntries, nextConversationCursor } from './inbox-conversation-model';

/**
 * An item's conversation: the first page comes with the item read (`first`), the rest is read
 * only when the person asks for more. Background refetches keep the merged turns on screen.
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
  const more = useInfiniteQuery({
    ...inboxConversationQueryOptions(scope, projectId, itemRef, from ?? {}, nextConversationCursor),
    enabled: Boolean(scope) && wantMore && from !== null,
  });
  const pages = more.data?.pages;
  const entries = useMemo(() => conversationEntries([first, ...(pages ?? [])]), [first, pages]);
  const hasMore = from !== null && (!wantMore || more.isError || more.hasNextPage === true);
  const loadMore = () => {
    if (!wantMore) setWantMore(true);
    else if (more.isError) void more.refetch();
    else if (more.hasNextPage && !more.isFetchingNextPage) void more.fetchNextPage();
  };
  return {
    entries,
    hasMore,
    loadingMore: wantMore && (more.isLoading || more.isFetchingNextPage),
    loadError: more.error,
    loadMore,
  };
}
