/**
 * The conversation around one comment, for the Comments page reader.
 *
 * One bidirectional infinite query: the first page is the comment's context window (the
 * whole commented message plus a few messages each side, from `.../comments/:id/context`);
 * earlier and later pages come from `.../messages` with exact cursors taken from the oldest
 * and newest rows already loaded. Pages stay in transcript order, so the rows are their
 * concatenation.
 */
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import {
  ApiClientError,
  type ChatMessageResponse,
  getMessageCommentContext,
  listChatMessages,
  type MessageCommentContext,
} from '../../lib/api';
import { newestPersistedCursor, oldestPersistedCursor } from '../../lib/message-paging';

type ReaderPageParam =
  { kind: 'context' } | { kind: 'before'; cursor: string } | { kind: 'after'; cursor: string };

interface ReaderPage {
  messages: ChatMessageResponse[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  /** Only on the first (context) page. */
  context: MessageCommentContext | null;
}

export const commentReaderQueryKeys = {
  all: (queryScope: string) => ['auth', queryScope, 'comment-reader'] as const,
  thread: (queryScope: string, projectId: string, sessionId: string, threadId: string) =>
    [...commentReaderQueryKeys.all(queryScope), projectId, sessionId, threadId] as const,
};

export interface CommentReaderTranscript {
  context: MessageCommentContext | null;
  /** Every loaded row, in transcript order. */
  rows: ChatMessageResponse[];
  /** True only before anything has loaded for this comment. */
  loading: boolean;
  /** The comment or its chat is gone, or the viewer cannot see it. */
  notFound: boolean;
  error: string | null;
  hasEarlier: boolean;
  hasLater: boolean;
  loadingEarlier: boolean;
  loadingLater: boolean;
  loadEarlier: () => void;
  loadLater: () => void;
  retry: () => void;
}

export function useCommentReaderTranscript(
  projectId: string,
  sessionId: string,
  threadId: string
): CommentReaderTranscript {
  const queryScope = useQueryScope();
  const query = useInfiniteQuery<
    ReaderPage,
    Error,
    InfiniteData<ReaderPage, ReaderPageParam>,
    readonly unknown[],
    ReaderPageParam
  >({
    queryKey: commentReaderQueryKeys.thread(queryScope, projectId, sessionId, threadId),
    enabled: Boolean(queryScope && projectId && sessionId && threadId),
    initialPageParam: { kind: 'context' },
    queryFn: async ({ pageParam, signal }) => {
      if (pageParam.kind === 'context') {
        const context = await getMessageCommentContext(projectId, sessionId, threadId, {
          signal,
        });
        return {
          messages: context.messages,
          hasMoreBefore: context.hasMoreBefore,
          hasMoreAfter: context.hasMoreAfter,
          context,
        };
      }
      if (pageParam.kind === 'before') {
        const page = await listChatMessages(projectId, sessionId, {
          before: pageParam.cursor,
          order: 'desc',
          signal,
        });
        return {
          messages: page.messages,
          hasMoreBefore: page.hasMore,
          hasMoreAfter: false,
          context: null,
        };
      }
      const page = await listChatMessages(projectId, sessionId, {
        after: pageParam.cursor,
        order: 'asc',
        signal,
      });
      return {
        messages: page.messages,
        hasMoreBefore: false,
        hasMoreAfter: page.hasMore,
        context: null,
      };
    },
    getPreviousPageParam: (first) => {
      const cursor = first.hasMoreBefore ? oldestPersistedCursor(first.messages) : undefined;
      return cursor ? { kind: 'before', cursor } : undefined;
    },
    getNextPageParam: (last) => {
      const cursor = last.hasMoreAfter ? newestPersistedCursor(last.messages) : undefined;
      return cursor ? { kind: 'after', cursor } : undefined;
    },
  });

  const pages = query.data?.pages;
  const context = useMemo(() => pages?.find((page) => page.context)?.context ?? null, [pages]);
  const rows = useMemo(() => pages?.flatMap((page) => page.messages) ?? [], [pages]);
  const status = query.error instanceof ApiClientError ? query.error.status : null;

  const { fetchPreviousPage, fetchNextPage, refetch } = query;
  // Stable: the conversation's edge-loading effects depend on these.
  const loadEarlier = useCallback(
    () => void fetchPreviousPage({ cancelRefetch: false }),
    [fetchPreviousPage]
  );
  const loadLater = useCallback(
    () => void fetchNextPage({ cancelRefetch: false }),
    [fetchNextPage]
  );
  const retry = useCallback(() => void refetch(), [refetch]);
  return {
    context,
    rows,
    loading: query.isPending,
    notFound: !context && (status === 404 || status === 403),
    error: !context && query.error ? query.error.message : null,
    hasEarlier: query.hasPreviousPage,
    hasLater: query.hasNextPage,
    loadingEarlier: query.isFetchingPreviousPage,
    loadingLater: query.isFetchingNextPage,
    loadEarlier,
    loadLater,
    retry,
  };
}
