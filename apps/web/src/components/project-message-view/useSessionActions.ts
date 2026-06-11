/**
 * useSessionActions — extracted action handlers for session lifecycle.
 * Keeps useSessionLifecycle.ts under the 500-line file size limit.
 */
import { useCallback, useRef } from 'react';

import type { ChatMessageResponse, ChatSessionResponse } from '../../lib/api';
import { cancelAgentPrompt, getChatSession, resetIdleTimer, sendFollowUpPrompt, uploadSessionFiles } from '../../lib/api';
import { mergeMessages } from '../../lib/merge-messages';
import type { SessionState } from './types';
import type { AgentActivityState } from './useSessionLifecycle';

interface UseSessionActionsParams {
  projectId: string;
  sessionId: string;
  sessionState: SessionState;
  session: ChatSessionResponse | null;
  agentActivity: AgentActivityState;
  followUp: string;
  sendingFollowUp: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  messages: ChatMessageResponse[];
  setFollowUp: (v: string) => void;
  setSendingFollowUp: (v: boolean) => void;
  setUploading: (v: boolean) => void;
  setAgentActivity: (v: AgentActivityState) => void;
  setSession: React.Dispatch<React.SetStateAction<ChatSessionResponse | null>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageResponse[]>>;
  setHasMore: (v: boolean) => void;
  setLoadingMore: (v: boolean) => void;
  setFirstItemIndex: React.Dispatch<React.SetStateAction<number>>;
  wsRef: React.RefObject<WebSocket | null>;
  recovery: { resumeAndSend: (text: string) => void };
}

export function useSessionActions(params: UseSessionActionsParams) {
  const {
    projectId, sessionId, sessionState, session, agentActivity,
    followUp, sendingFollowUp, hasMore, loadingMore, messages,
    setFollowUp, setSendingFollowUp, setUploading, setAgentActivity,
    setSession, setMessages, setHasMore, setLoadingMore,
    setFirstItemIndex, wsRef, recovery,
  } = params;

  // Send follow-up via REST API
  const handleSendFollowUp = async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
    setAgentActivity('prompting');
    try {
      if (sessionState === 'idle') {
        resetIdleTimer(projectId, sessionId)
          .then((result) => {
            if (result.cleanupAt) {
              setSession((prev) => {
                if (!prev) return prev;
                return { ...prev, cleanupAt: result.cleanupAt, isIdle: false, agentCompletedAt: null } as ChatSessionResponse;
              });
            }
          })
          .catch(() => {});
      }

      // Optimistic user message
      const optimisticId = `optimistic-${crypto.randomUUID()}`;
      setMessages((prev) => [...prev, {
        id: optimisticId,
        sessionId,
        role: 'user',
        content: trimmed,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);

      // Persist via DO WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'message.send',
          sessionId,
          content: trimmed,
          role: 'user',
        }));
      }

      // For idle sessions, resume first then send the prompt
      if (sessionState === 'idle' && session?.workspaceId && session?.agentSessionId) {
        recovery.resumeAndSend(trimmed);
      } else {
        try {
          await sendFollowUpPrompt(projectId, sessionId, trimmed);
        } catch {
          setAgentActivity('idle');
        }
      }

      setFollowUp('');
    } finally {
      setSendingFollowUp(false);
    }
  };

  // Upload files
  const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    setUploading(true);
    try {
      const result = await uploadSessionFiles(projectId, sessionId, fileArray);
      const names = result.files.map((f) => f.name).join(', ');
      setMessages((prev) => [...prev, {
        id: `optimistic-upload-${crypto.randomUUID()}`,
        sessionId,
        role: 'user' as const,
        content: `Uploaded ${result.files.length} file${result.files.length > 1 ? 's' : ''}: ${names}`,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);
    } catch (err) {
      console.error('File upload failed:', err);
    } finally {
      setUploading(false);
    }
  }, [projectId, sessionId, setUploading, setMessages]);

  // Cancel current prompt
  const cancellingRef = useRef(false);
  const handleCancelPrompt = useCallback(() => {
    if (agentActivity === 'idle' || cancellingRef.current) return;
    cancellingRef.current = true;
    cancelAgentPrompt(projectId, sessionId)
      .then(() => { setAgentActivity('idle'); })
      .catch(() => {})
      .finally(() => { cancellingRef.current = false; });
  }, [agentActivity, projectId, sessionId, setAgentActivity]);

  // Load more (pagination)
  const loadMore = async () => {
    if (!hasMore || loadingMore) return;
    const firstMessage = messages[0];
    if (!firstMessage) return;

    setLoadingMore(true);
    try {
      const data = await getChatSession(projectId, sessionId, {
        before: firstMessage.createdAt,
      });
      setMessages((prev) => {
        const merged = mergeMessages(prev, data.messages, 'prepend');
        const actualAdded = merged.length - prev.length;
        setFirstItemIndex((fi) => fi - actualAdded);
        return merged;
      });
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  };

  return { handleSendFollowUp, handleUploadFiles, handleCancelPrompt, loadMore };
}
