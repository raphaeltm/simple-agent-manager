import type { InboxConversation, InboxFilter } from '@simple-agent-manager/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { getInboxCount, getInboxItem, type InboxConversationCursor, listInbox } from '../api';

/**
 * Inbox queries (slice C). Keys follow the `['auth', scope, domain, …]` invariant documented in
 * `./index.ts`; `projectId: null` is the cross-project inbox. Inbox data holds agent-written
 * free text, so none of these keys are persisted.
 *
 * Freshness: fetched on load, refetched when the window regains focus, and invalidated when the
 * notification socket reports something new (`useNotificationSocket`). There is no interval poll.
 */
export const inboxQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'inbox'] as const,
  lists: (queryScope: string) => [...inboxQueryKeys.all(queryScope), 'list'] as const,
  list: (queryScope: string, projectId: string | null, filter: InboxFilter) =>
    [...inboxQueryKeys.lists(queryScope), projectId ?? 'all', filter] as const,
  counts: (queryScope: string) => [...inboxQueryKeys.all(queryScope), 'count'] as const,
  count: (queryScope: string, projectId: string | null) =>
    [...inboxQueryKeys.counts(queryScope), projectId ?? 'all'] as const,
  items: (queryScope: string) => [...inboxQueryKeys.all(queryScope), 'item'] as const,
  item: (queryScope: string, projectId: string, ref: string) =>
    [...inboxQueryKeys.items(queryScope), projectId, ref] as const,
  /** Pages of an item's conversation after the first read, starting at `from`. */
  conversation: (
    queryScope: string,
    projectId: string,
    ref: string,
    from: InboxConversationCursor
  ) =>
    [
      ...inboxQueryKeys.item(queryScope, projectId, ref),
      'conversation',
      from.replyCursor ?? null,
      from.responseCursor ?? null,
    ] as const,
};

export function inboxCountQueryOptions(queryScope: string, projectId: string | null) {
  return queryOptions({
    queryKey: inboxQueryKeys.count(queryScope, projectId),
    queryFn: ({ signal }) => getInboxCount(projectId, signal),
    enabled: Boolean(queryScope),
    refetchOnWindowFocus: true,
  });
}

export function inboxListQueryOptions(
  queryScope: string,
  projectId: string | null,
  filter: InboxFilter
) {
  return infiniteQueryOptions({
    queryKey: inboxQueryKeys.list(queryScope, projectId, filter),
    queryFn: ({ pageParam, signal }) => listInbox({ projectId, filter, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: Boolean(queryScope),
    refetchOnWindowFocus: true,
  });
}

export function inboxItemQueryOptions(queryScope: string, projectId: string, ref: string) {
  return queryOptions({
    queryKey: inboxQueryKeys.item(queryScope, projectId, ref),
    queryFn: ({ signal }) => getInboxItem(projectId, ref, signal),
    enabled: Boolean(queryScope && projectId && ref),
    // A closed or missing item is an answer, not a transient failure.
    retry: false,
    refetchOnWindowFocus: true,
  });
}

/**
 * The rest of an item's conversation, read only when the person asks for it. The first page is
 * the item read itself; this continues from its cursors. Invalidating the item refetches it too.
 */
export function inboxConversationQueryOptions(
  queryScope: string,
  projectId: string,
  ref: string,
  from: InboxConversationCursor,
  nextCursor: (page: InboxConversation | null) => InboxConversationCursor | null
) {
  return infiniteQueryOptions({
    queryKey: inboxQueryKeys.conversation(queryScope, projectId, ref, from),
    queryFn: async ({ pageParam, signal }) =>
      (await getInboxItem(projectId, ref, signal, pageParam)).conversation ?? null,
    initialPageParam: from,
    getNextPageParam: (last) => nextCursor(last) ?? undefined,
    retry: false,
  });
}
