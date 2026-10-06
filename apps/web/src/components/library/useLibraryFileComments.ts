import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import {
  createLibraryFileCommentThread,
  type LibraryFileCommentThread,
  type MessageCommentAuthor,
  type MessageCommentReply,
  reopenLibraryFileComment,
  replyToLibraryFileComment,
  resolveLibraryFileComment,
} from '../../lib/api/comments';
import {
  libraryFileCommentQueryKeys,
  libraryFileCommentsQueryOptions,
  upsertLibraryFileCommentThread,
} from '../../lib/query-options/comments';
import { useAuth } from '../AuthProvider';
import {
  buildOptimisticAuthor,
  createOptimisticId,
  type UiCommentThread,
  type UiMessageCommentReply,
} from '../project-message-view/comments/comment-utils';

/**
 * Maps a library-file thread onto the anchor-agnostic shape the shared comment
 * components render. The anchor is passed through as-is: an earlier cut forged
 * `{ kind: 'message', messageId: thread.fileId }` here to satisfy a
 * message-typed prop, which defeated the discriminated union at exactly the
 * boundary it exists to protect.
 */
export function fileThreadToUi(thread: LibraryFileCommentThread): UiCommentThread {
  return {
    id: thread.id,
    clientId: thread.clientId ?? null,
    projectId: thread.projectId,
    anchor: thread.anchor,
    author: thread.author,
    body: thread.body,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    replies: thread.replies.map((r): UiMessageCommentReply => ({ ...r, syncState: 'synced' })),
    syncState: 'synced',
  };
}

function makeOptimisticFileThread(
  projectId: string,
  fileId: string,
  body: string,
  author: MessageCommentAuthor,
  opts?: { quote?: string; clientId?: string }
): LibraryFileCommentThread {
  const now = Date.now();
  return {
    id: createOptimisticId('file-thread'),
    clientId: opts?.clientId ?? null,
    projectId,
    fileId,
    anchor: { kind: 'library_file', fileId, quote: opts?.quote },
    author,
    body,
    createdAt: now,
    updatedAt: now,
    status: 'open',
    replies: [],
  };
}

function makeOptimisticReply(
  body: string,
  author: MessageCommentAuthor,
  clientId?: string
): MessageCommentReply {
  const now = Date.now();
  return {
    id: createOptimisticId('file-reply'),
    clientId: clientId ?? null,
    author,
    body,
    createdAt: now,
    updatedAt: now,
    sentToAgent: false,
  };
}

type OptimisticMutationContext = {
  queryClient: ReturnType<typeof useQueryClient>;
  queryKey: readonly unknown[];
  setCache: (
    updater: (prev: LibraryFileCommentThread[] | undefined) => LibraryFileCommentThread[]
  ) => void;
  setMutationError: (message: string | null) => void;
};

/**
 * All four comment mutations share the same optimistic shape: snapshot the
 * cache, apply a local edit, roll back and report the reason on failure, write
 * the authoritative server row on success. Only the request and the local edit
 * differ, so those are the only things a caller supplies.
 *
 * Deliberately no `onSettled` invalidation: `onSuccess` already stores the
 * server's row, so refetching after every mutation only doubles the round trips
 * (.claude/rules/60-request-io-and-bundle-budgets.md).
 */
function useOptimisticThreadMutation<TInput>(
  ctx: OptimisticMutationContext,
  mutationFn: (input: TInput) => Promise<{ thread: LibraryFileCommentThread }>,
  applyOptimistic: (
    threads: LibraryFileCommentThread[],
    input: TInput
  ) => LibraryFileCommentThread[]
) {
  return useMutation({
    mutationFn,
    onMutate: async (input: TInput) => {
      ctx.setMutationError(null);
      await ctx.queryClient.cancelQueries({ queryKey: ctx.queryKey });
      const previous = ctx.queryClient.getQueryData<LibraryFileCommentThread[]>(ctx.queryKey);
      ctx.setCache((prev) => applyOptimistic(prev ?? [], input));
      return { previous };
    },
    onError: (err, _input, rollback) => {
      if (rollback?.previous) ctx.queryClient.setQueryData(ctx.queryKey, rollback.previous);
      ctx.setMutationError(err instanceof Error ? err.message : 'Could not save that comment.');
      void ctx.queryClient.invalidateQueries({ queryKey: ctx.queryKey });
    },
    onSuccess: (response) => {
      ctx.setCache((prev) => upsertLibraryFileCommentThread(prev, response.thread));
    },
  });
}

export function useLibraryFileComments(projectId: string, fileId: string) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // A failed mutation rolls the optimistic row back, which on its own looks
  // identical to "nothing happened". Surface the reason instead.
  const [mutationError, setMutationError] = useState<string | null>(null);
  const queryKey = useMemo(
    () => libraryFileCommentQueryKeys.file(queryScope, projectId, fileId),
    [queryScope, projectId, fileId]
  );

  const commentsQuery = useQuery({
    ...libraryFileCommentsQueryOptions(queryScope, projectId, fileId),
    enabled: Boolean(queryScope && projectId && fileId),
    select: (threads): UiCommentThread[] => threads.map(fileThreadToUi),
  });

  const setCache = useCallback(
    (updater: (prev: LibraryFileCommentThread[] | undefined) => LibraryFileCommentThread[]) => {
      queryClient.setQueryData<LibraryFileCommentThread[]>(queryKey, (prev) => updater(prev));
    },
    [queryClient, queryKey]
  );

  const shared = useMemo(
    () => ({ queryClient, queryKey, setCache, setMutationError }),
    [queryClient, queryKey, setCache]
  );

  const createThreadMutation = useOptimisticThreadMutation(
    shared,
    (input: { body: string; quote?: string; clientId: string }) =>
      createLibraryFileCommentThread(projectId, fileId, {
        body: input.body,
        quote: input.quote,
        clientMutationId: input.clientId,
      }),
    (threads, input) => [
      ...threads,
      makeOptimisticFileThread(projectId, fileId, input.body, buildOptimisticAuthor(user), {
        quote: input.quote,
        clientId: input.clientId,
      }),
    ]
  );

  const replyMutation = useOptimisticThreadMutation(
    shared,
    (input: { threadId: string; body: string; clientId: string }) =>
      replyToLibraryFileComment(projectId, fileId, input.threadId, {
        body: input.body,
        clientMutationId: input.clientId,
      }),
    (threads, input) => {
      const reply = makeOptimisticReply(input.body, buildOptimisticAuthor(user), input.clientId);
      return threads.map((t) =>
        t.id === input.threadId ? { ...t, replies: [...t.replies, reply] } : t
      );
    }
  );

  const resolveMutation = useOptimisticThreadMutation(
    shared,
    (threadId: string) => resolveLibraryFileComment(projectId, fileId, threadId),
    (threads, threadId) =>
      threads.map((t) => (t.id === threadId ? { ...t, status: 'resolved' as const } : t))
  );

  const reopenMutation = useOptimisticThreadMutation(
    shared,
    (threadId: string) => reopenLibraryFileComment(projectId, fileId, threadId),
    (threads, threadId) =>
      threads.map((t) => (t.id === threadId ? { ...t, status: 'open' as const } : t))
  );

  return {
    comments: commentsQuery.data ?? [],
    loading: commentsQuery.isPending && commentsQuery.data === undefined,
    refreshing: commentsQuery.isFetching && commentsQuery.data !== undefined,
    error: commentsQuery.error instanceof Error ? commentsQuery.error.message : null,
    mutationError,
    createThread: (body: string, quote?: string) =>
      createThreadMutation.mutateAsync({
        body,
        quote,
        clientId: createOptimisticId('client-file-thread'),
      }),
    reply: (threadId: string, body: string) =>
      replyMutation.mutateAsync({
        threadId,
        body,
        clientId: createOptimisticId('client-file-reply'),
      }),
    resolve: (threadId: string) => resolveMutation.mutateAsync(threadId),
    reopen: (threadId: string) => reopenMutation.mutateAsync(threadId),
    applyingMutation:
      createThreadMutation.isPending ||
      replyMutation.isPending ||
      resolveMutation.isPending ||
      reopenMutation.isPending,
  };
}
