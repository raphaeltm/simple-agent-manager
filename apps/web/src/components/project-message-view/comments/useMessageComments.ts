import type { CommentMention } from '@simple-agent-manager/shared';
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

/**
 * `mentions` is required, not optional: a caller that forgets to forward the composer's picks
 * fails to compile instead of silently notifying nobody. Pass `[]` when there are none.
 * The display names only label the optimistic copy; the request carries the IDs alone.
 */
interface CreateThreadInput {
  messageId: string;
  quote?: string;
  body: string;
  action: MessageCommentAction;
  mentions: CommentMention[];
}

interface ReplyInput {
  commentId: string;
  body: string;
  action: MessageCommentAction;
  mentions: CommentMention[];
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
        mentions: input.mentions,
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
        mentions: input.mentions,
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
        mentions: input.mentions,
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
                    mentions: input.mentions,
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

  // `mutateAsync` is stable for a mounted mutation, so these keep one identity across renders
  // and the comment UI's memoized actions do not rebuild on every streamed token.
  const { mutateAsync: createThreadAsync } = createThreadMutation;
  const { mutateAsync: replyAsync } = replyMutation;
  const { mutateAsync: resolveAsync } = resolveMutation;
  const { mutateAsync: reopenAsync } = reopenMutation;
  const { mutateAsync: sendAsync } = sendMutation;
  const createThread = useCallback(
    (input: CreateThreadInput) =>
      createThreadAsync({ ...input, clientId: createOptimisticId('client-thread') }),
    [createThreadAsync]
  );
  const reply = useCallback(
    (input: ReplyInput) => replyAsync({ ...input, clientId: createOptimisticId('client-reply') }),
    [replyAsync]
  );
  const resolve = useCallback((commentId: string) => resolveAsync(commentId), [resolveAsync]);
  const reopen = useCallback((commentId: string) => reopenAsync(commentId), [reopenAsync]);
  const sendToAgent = useCallback((input: SendInput) => sendAsync(input), [sendAsync]);

  return {
    comments: commentsQuery.data ?? [],
    loading: commentsQuery.isPending && commentsQuery.data === undefined,
    refreshing: commentsQuery.isFetching && commentsQuery.data !== undefined,
    error: commentsQuery.error instanceof Error ? commentsQuery.error.message : null,
    refetch: commentsQuery.refetch,
    createThread,
    reply,
    resolve,
    reopen,
    sendToAgent,
    applyingMutation:
      createThreadMutation.isPending ||
      replyMutation.isPending ||
      resolveMutation.isPending ||
      reopenMutation.isPending ||
      sendMutation.isPending,
    applyRealtimeEvent,
  };
}
