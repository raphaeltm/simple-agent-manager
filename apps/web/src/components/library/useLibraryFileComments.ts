import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

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
  type UiMessageCommentReply,
  type UiMessageCommentThread,
} from '../project-message-view/comments/comment-utils';

function fileThreadToUi(thread: LibraryFileCommentThread): UiMessageCommentThread {
  return {
    id: thread.id,
    clientId: thread.clientId ?? null,
    projectId: thread.projectId,
    sessionId: '',
    anchor: { kind: 'message', messageId: thread.fileId, quote: thread.anchor.quote },
    author: thread.author,
    body: thread.body,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    replies: thread.replies.map(
      (r): UiMessageCommentReply => ({ ...r, syncState: 'synced' })
    ),
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

export function useLibraryFileComments(projectId: string, fileId: string) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const queryKey = useMemo(
    () => libraryFileCommentQueryKeys.file(queryScope, projectId, fileId),
    [queryScope, projectId, fileId]
  );

  const commentsQuery = useQuery({
    ...libraryFileCommentsQueryOptions(queryScope, projectId, fileId),
    enabled: Boolean(queryScope && projectId && fileId),
    select: (threads): UiMessageCommentThread[] => threads.map(fileThreadToUi),
  });

  const setCache = useCallback(
    (
      updater: (
        prev: LibraryFileCommentThread[] | undefined
      ) => LibraryFileCommentThread[]
    ) => {
      queryClient.setQueryData<LibraryFileCommentThread[]>(queryKey, (prev) =>
        updater(prev)
      );
    },
    [queryClient, queryKey]
  );

  const createThreadMutation = useMutation({
    mutationFn: (input: { body: string; quote?: string; clientId: string }) =>
      createLibraryFileCommentThread(projectId, fileId, {
        body: input.body,
        quote: input.quote,
        clientMutationId: input.clientId,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<LibraryFileCommentThread[]>(queryKey);
      const optimistic = makeOptimisticFileThread(
        projectId,
        fileId,
        input.body,
        buildOptimisticAuthor(user),
        { quote: input.quote, clientId: input.clientId }
      );
      setCache((prev) => [...(prev ?? []), optimistic]);
      return { previous, optimisticId: optimistic.id };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKey, ctx.previous);
      }
    },
    onSuccess: (response) => {
      setCache((prev) => upsertLibraryFileCommentThread(prev, response.thread));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const replyMutation = useMutation({
    mutationFn: (input: { threadId: string; body: string; clientId: string }) =>
      replyToLibraryFileComment(projectId, fileId, input.threadId, {
        body: input.body,
        clientMutationId: input.clientId,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<LibraryFileCommentThread[]>(queryKey);
      const reply = makeOptimisticReply(input.body, buildOptimisticAuthor(user), input.clientId);
      setCache((prev) =>
        (prev ?? []).map((t) =>
          t.id === input.threadId ? { ...t, replies: [...t.replies, reply] } : t
        )
      );
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSuccess: (response) => {
      setCache((prev) => upsertLibraryFileCommentThread(prev, response.thread));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (threadId: string) => resolveLibraryFileComment(projectId, fileId, threadId),
    onMutate: async (threadId) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<LibraryFileCommentThread[]>(queryKey);
      setCache((prev) =>
        (prev ?? []).map((t) =>
          t.id === threadId ? { ...t, status: 'resolved' as const } : t
        )
      );
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSuccess: (response) => {
      setCache((prev) => upsertLibraryFileCommentThread(prev, response.thread));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: (threadId: string) => reopenLibraryFileComment(projectId, fileId, threadId),
    onMutate: async (threadId) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<LibraryFileCommentThread[]>(queryKey);
      setCache((prev) =>
        (prev ?? []).map((t) =>
          t.id === threadId ? { ...t, status: 'open' as const } : t
        )
      );
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSuccess: (response) => {
      setCache((prev) => upsertLibraryFileCommentThread(prev, response.thread));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    comments: commentsQuery.data ?? [],
    loading: commentsQuery.isPending && commentsQuery.data === undefined,
    refreshing: commentsQuery.isFetching && commentsQuery.data !== undefined,
    error: commentsQuery.error instanceof Error ? commentsQuery.error.message : null,
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
