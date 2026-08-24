import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useQueryScope } from '../../../hooks/useQueryScope';
import {
  createMessageCommentReply,
  createMessageCommentThread,
  type MessageCommentAction,
  type MessageCommentRealtimeEvent,
  type MessageCommentThread,
  reopenMessageCommentThread,
  resolveMessageCommentThread,
  sendMessageCommentThreadToAgent,
} from '../../../lib/api/comments';
import {
  applyMessageCommentRealtimeEventToQueryCache,
  messageCommentQueryKeys,
  messageCommentsQueryOptions,
} from '../../../lib/query-options';
import { useAuth } from '../../AuthProvider';
import {
  buildOptimisticAuthor,
  createOptimisticId,
  normalizeThread,
  threadStatusForAction,
  type UiMessageCommentThread,
  upsertThread,
} from './comment-utils';

interface CreateThreadInput {
  messageId: string;
  quote?: string;
  body: string;
  action: MessageCommentAction;
}

interface ReplyInput {
  commentId: string;
  body: string;
  action: MessageCommentAction;
}

interface SendInput {
  commentId: string;
  body?: string;
}

function markThreadFailed(
  previous: readonly UiMessageCommentThread[] | undefined,
  optimisticId: string
): UiMessageCommentThread[] {
  return (previous ?? []).map((thread) =>
    thread.id === optimisticId ? { ...thread, syncState: 'failed' } : thread
  );
}

function replaceThread(
  previous: readonly UiMessageCommentThread[] | undefined,
  incoming: MessageCommentThread
): UiMessageCommentThread[] {
  return upsertThread(previous, incoming);
}

export function useMessageComments(projectId: string, sessionId: string, enabled: boolean) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const queryKey = useMemo(
    () => messageCommentQueryKeys.session(queryScope, projectId, sessionId),
    [projectId, queryScope, sessionId]
  );

  const commentsQuery = useQuery({
    ...messageCommentsQueryOptions(queryScope, projectId, sessionId),
    enabled: enabled && Boolean(queryScope && projectId && sessionId),
    select: (comments): UiMessageCommentThread[] => comments.map(normalizeThread),
  });

  const setComments = useCallback(
    (
      updater: (
        previous: UiMessageCommentThread[] | undefined
      ) => UiMessageCommentThread[] | undefined
    ) => {
      queryClient.setQueryData<UiMessageCommentThread[] | MessageCommentThread[] | undefined>(
        queryKey,
        (previous) => updater(previous?.map((thread) => normalizeThread(thread)))
      );
    },
    [queryClient, queryKey]
  );

  const createThreadMutation = useMutation({
    mutationFn: (input: CreateThreadInput & { clientId: string }) =>
      createMessageCommentThread(projectId, sessionId, {
        clientId: input.clientId,
        anchor: { kind: 'message', messageId: input.messageId, quote: input.quote },
        body: input.body,
        action: input.action,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const optimisticId = createOptimisticId('thread');
      const now = Date.now();
      const optimisticThread: UiMessageCommentThread = {
        id: optimisticId,
        clientId: input.clientId,
        projectId,
        sessionId,
        anchor: { kind: 'message', messageId: input.messageId, quote: input.quote },
        author: buildOptimisticAuthor(user),
        body: input.body,
        createdAt: now,
        updatedAt: now,
        status: threadStatusForAction(input.action),
        replies: [],
        syncState: 'pending',
      };
      setComments((previous) => [...(previous ?? []), optimisticThread]);
      return { optimisticId };
    },
    onError: (_error, _input, context) => {
      if (context) setComments((previous) => markThreadFailed(previous, context.optimisticId));
    },
    onSuccess: (response) => {
      setComments((previous) => replaceThread(previous, response.comment));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const replyMutation = useMutation({
    mutationFn: (input: ReplyInput & { clientId: string }) =>
      createMessageCommentReply(projectId, sessionId, input.commentId, {
        clientId: input.clientId,
        body: input.body,
        action: input.action,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      const optimisticReplyId = createOptimisticId('reply');
      const now = Date.now();
      setComments((previous) =>
        (previous ?? []).map((thread) =>
          thread.id === input.commentId
            ? {
                ...thread,
                status: input.action === 'send_to_agent' ? 'sent' : thread.status,
                replies: [
                  ...thread.replies,
                  {
                    id: optimisticReplyId,
                    clientId: input.clientId,
                    author: buildOptimisticAuthor(user),
                    body: input.body,
                    createdAt: now,
                    updatedAt: now,
                    sentToAgent: input.action === 'send_to_agent',
                    syncState: 'pending',
                  },
                ],
              }
            : thread
        )
      );
      return { optimisticReplyId };
    },
    onSuccess: (response) => {
      setComments((previous) => replaceThread(previous, response.comment));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: (commentId: string) => resolveMessageCommentThread(projectId, sessionId, commentId),
    onMutate: async (commentId) => {
      await queryClient.cancelQueries({ queryKey });
      setComments((previous) =>
        (previous ?? []).map((thread) =>
          thread.id === commentId ? { ...thread, status: 'resolved', syncState: 'pending' } : thread
        )
      );
    },
    onSuccess: (response) => {
      setComments((previous) => replaceThread(previous, response.comment));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: (commentId: string) => reopenMessageCommentThread(projectId, sessionId, commentId),
    onMutate: async (commentId) => {
      await queryClient.cancelQueries({ queryKey });
      setComments((previous) =>
        (previous ?? []).map((thread) =>
          thread.id === commentId ? { ...thread, status: 'open', syncState: 'pending' } : thread
        )
      );
    },
    onSuccess: (response) => {
      setComments((previous) => replaceThread(previous, response.comment));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const sendMutation = useMutation({
    mutationFn: (input: SendInput) =>
      sendMessageCommentThreadToAgent(projectId, sessionId, input.commentId, { body: input.body }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey });
      setComments((previous) =>
        (previous ?? []).map((thread) =>
          thread.id === input.commentId
            ? { ...thread, status: 'sent', syncState: 'pending' }
            : thread
        )
      );
    },
    onSuccess: (response) => {
      setComments((previous) => replaceThread(previous, response.comment));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const applyRealtimeEvent = useCallback(
    (event: MessageCommentRealtimeEvent) => {
      if (!queryScope) return;
      if (event.payload.projectId !== projectId || event.payload.sessionId !== sessionId) return;
      applyMessageCommentRealtimeEventToQueryCache(queryClient, queryScope, event);
    },
    [projectId, queryClient, queryScope, sessionId]
  );

  return {
    comments: commentsQuery.data ?? [],
    loading: commentsQuery.isPending && commentsQuery.data === undefined,
    refreshing: commentsQuery.isFetching && commentsQuery.data !== undefined,
    error: commentsQuery.error instanceof Error ? commentsQuery.error.message : null,
    refetch: commentsQuery.refetch,
    createThread: (input: CreateThreadInput) =>
      createThreadMutation.mutateAsync({ ...input, clientId: createOptimisticId('client-thread') }),
    reply: (input: ReplyInput) =>
      replyMutation.mutateAsync({ ...input, clientId: createOptimisticId('client-reply') }),
    resolve: (commentId: string) => resolveMutation.mutateAsync(commentId),
    reopen: (commentId: string) => reopenMutation.mutateAsync(commentId),
    sendToAgent: (input: SendInput) => sendMutation.mutateAsync(input),
    applyingMutation:
      createThreadMutation.isPending ||
      replyMutation.isPending ||
      resolveMutation.isPending ||
      reopenMutation.isPending ||
      sendMutation.isPending,
    applyRealtimeEvent,
  };
}
