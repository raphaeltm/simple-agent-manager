import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import {
  type ChatSessionResponse,
  closeConversationTask,
  sleepChatSession,
  stopChatSession,
} from '../../lib/api';
import { chatQueryKeys } from '../../lib/query-options';

interface ConversationActionsInput {
  projectId: string;
  sessionId: string | undefined;
  /** The selected session, waiting for the first list read when it has not landed. */
  findSession: (id: string) => Promise<ChatSessionResponse | undefined>;
  loadSessions: () => Promise<unknown>;
}

/** Sleep and close for the selected conversation, with their in-flight and error state. */
export function useConversationActions({
  projectId,
  sessionId,
  findSession,
  loadSessions,
}: ConversationActionsInput) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const [sleepingConversation, setSleepingConversation] = useState(false);
  const [sleepError, setSleepError] = useState<string | null>(null);
  const [closingConversation, setClosingConversation] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  const handleSleepConversation = useCallback(async () => {
    if (!sessionId) return;
    setSleepingConversation(true);
    setSleepError(null);
    try {
      const selectedSession = await findSession(sessionId);
      if (!selectedSession) return;
      if (!selectedSession.workspaceId) {
        setSleepError('This session has no workspace to sleep.');
        return;
      }
      // Session-scoped: works for the owner and for anyone they shared the session with.
      await sleepChatSession(projectId, selectedSession.id);
      if (queryScope) {
        await queryClient.invalidateQueries({
          queryKey: chatQueryKeys.sessionMessages(queryScope, projectId, selectedSession.id),
        });
      }
      void loadSessions();
    } catch (err) {
      console.warn('Failed to sleep conversation:', err);
      setSleepError(err instanceof Error ? err.message : 'Failed to sleep conversation');
    } finally {
      setSleepingConversation(false);
    }
  }, [findSession, loadSessions, projectId, queryClient, queryScope, sessionId]);

  const handleCloseConversation = useCallback(async () => {
    if (!sessionId) return;
    setClosingConversation(true);
    setCloseError(null);
    try {
      const selectedSession = await findSession(sessionId);
      if (!selectedSession) return;
      if (selectedSession.taskId) {
        await closeConversationTask(projectId, selectedSession.taskId);
      } else {
        await stopChatSession(projectId, selectedSession.id);
      }
      void loadSessions();
    } catch (err) {
      console.warn('Failed to close conversation:', err);
      setCloseError(err instanceof Error ? err.message : 'Failed to close conversation');
    } finally {
      setClosingConversation(false);
    }
  }, [findSession, projectId, sessionId, loadSessions]);

  return {
    sleepingConversation,
    sleepError,
    handleSleepConversation,
    closingConversation,
    closeError,
    handleCloseConversation,
  };
}
