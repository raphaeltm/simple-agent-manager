/**
 * WorkspaceChatView — lightweight chat component for the workspace page.
 *
 * Unlike ProjectMessageView which uses the heavyweight useSessionLifecycle hook
 * (with its own workspace fetching, token refresh, port detection, connection
 * recovery, and polling), this component reuses the workspace page's existing
 * state and only manages the chat-specific concerns:
 *
 * 1. Load chat messages from the DO via getChatSession()
 * 2. Real-time message updates via useChatWebSocket
 * 3. ACP agent interaction via useProjectAgentSession
 * 4. Message rendering via AcpConversationItemView + FollowUpInput
 *
 * This avoids the duplicate hook instances that caused React error #185
 * (infinite render loops) when ProjectMessageView was embedded in the
 * workspace page context.
 */
import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { Spinner } from '@simple-agent-manager/ui';
import { ChevronDown } from 'lucide-react';
import { type FC, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { AcpConversationItemView } from '../../components/project-message-view/AcpConversationItemView';
import { FollowUpInput } from '../../components/project-message-view/FollowUpInput';
import { chatMessagesToConversationItems, deriveSessionState, VIRTUAL_START } from '../../components/project-message-view/types';
import { useChatWebSocket } from '../../hooks/useChatWebSocket';
import { useProjectAgentSession } from '../../hooks/useProjectAgentSession';
import { getChatSession, getTranscribeApiUrl, resetIdleTimer, uploadSessionFiles } from '../../lib/api';
import type { ChatMessageResponse, ChatSessionDetailResponse, ChatSessionResponse } from '../../lib/api/sessions';
import { mergeMessages } from '../../lib/merge-messages';

interface WorkspaceChatViewProps {
  projectId: string;
  sessionId: string;
}

/**
 * Memoized to prevent re-renders from the workspace page's 5s polling cycle.
 * The parent re-renders every poll, but our props (string IDs) don't change.
 */
export const WorkspaceChatView: FC<WorkspaceChatViewProps> = memo(function WorkspaceChatView({
  projectId,
  sessionId,
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // ── Core state ──
  const [session, setSession] = useState<ChatSessionResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessageResponse[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Follow-up ──
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [uploading, setUploading] = useState(false);

  // ── Scroll ──
  const [firstItemIndex, setFirstItemIndex] = useState(VIRTUAL_START);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const sessionState = session ? deriveSessionState(session) : 'terminated';
  const agentSessionId = session?.agentSessionId ?? null;
  const transcribeApiUrl = useMemo(() => getTranscribeApiUrl(), []);

  // ── DO WebSocket for real-time message updates ──
  const { connectionState, wsRef } = useChatWebSocket({
    projectId,
    sessionId,
    enabled: session?.status === 'active',
    onMessage: useCallback((msg: ChatMessageResponse) => {
      setMessages((prev) => mergeMessages(prev, [msg], 'append'));
    }, []),
    onSessionStopped: useCallback(() => {
      setSession((prev) => prev ? { ...prev, status: 'stopped' } : prev);
    }, []),
    onCatchUp: useCallback((catchUpMsgs: ChatMessageResponse[], catchUpSession: ChatSessionResponse, catchUpHasMore: boolean) => {
      setSession(catchUpSession);
      setMessages((prev) => mergeMessages(prev, catchUpMsgs, 'replace'));
      setHasMore(catchUpHasMore);
    }, []),
    onAgentCompleted: useCallback((agentCompletedAt: number) => {
      setSession((prev) => prev ? { ...prev, agentCompletedAt, isIdle: true } as ChatSessionResponse : prev);
    }, []),
  });

  // ── ACP agent session for direct agent interaction ──
  const agentSession = useProjectAgentSession({
    workspaceId: session?.workspaceId ?? null,
    sessionId: agentSessionId ?? sessionId,
    enabled: (sessionState === 'active' || sessionState === 'idle') && agentSessionId !== null,
    preferredAgentType: undefined,
  });

  // ── Load session data ──
  const loadSession = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      const data: ChatSessionDetailResponse = await getChatSession(projectId, sessionId);
      setSession(data.session);
      setMessages(data.messages);
      setHasMore(data.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => { void loadSession(); }, [loadSession]);

  // Reset scroll on session change
  useEffect(() => {
    setFirstItemIndex(VIRTUAL_START);
    setShowScrollButton(false);
  }, [sessionId]);

  // ── Conversation items from merged sources ──
  const conversationItems = useMemo<ConversationItem[]>(() => {
    const doItems = chatMessagesToConversationItems(messages);
    // Merge ACP real-time items (streaming agent output) with DO-persisted messages
    const acpItems = agentSession.messages.items;
    if (acpItems.length === 0) return doItems;
    // ACP items are newer — append them after DO items, deduplicating by kind+content
    const doIdSet = new Set(doItems.map((i) => i.id));
    const uniqueAcp = acpItems.filter((i) => !doIdSet.has(i.id));
    return [...doItems, ...uniqueAcp];
  }, [messages, agentSession.messages.items]);

  // ── Send follow-up message ──
  const handleSendFollowUp = useCallback(async () => {
    const trimmed = followUp.trim();
    if (!trimmed || sendingFollowUp) return;

    setSendingFollowUp(true);
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

      // Optimistic message
      setMessages((prev) => [...prev, {
        id: `optimistic-${crypto.randomUUID()}`,
        sessionId,
        role: 'user',
        content: trimmed,
        toolMetadata: null,
        createdAt: Date.now(),
      }]);

      // Send via DO WebSocket
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'message.send',
          sessionId,
          content: trimmed,
          role: 'user',
        }));
      }

      // Send via ACP for agent interaction
      if (agentSession.isAgentActive) {
        agentSession.sendPrompt(trimmed);
      }

      setFollowUp('');
    } finally {
      setSendingFollowUp(false);
    }
  }, [followUp, sendingFollowUp, sessionState, projectId, sessionId, wsRef, agentSession]);

  // ── Upload files ──
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
  }, [projectId, sessionId]);

  // ── Load more (pagination) ──
  const loadMore = useCallback(async () => {
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
        if (actualAdded > 0) {
          setFirstItemIndex((fi) => fi - actualAdded);
        }
        return merged;
      });
      setHasMore(data.hasMore);
    } catch {
      // Best-effort pagination
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, messages, projectId, sessionId]);

  // ── Render ──
  if (loading && messages.length === 0 && !session) {
    return (
      <div className="flex justify-center p-8">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="p-4 text-danger text-sm">
        {error}
      </div>
    );
  }

  const isActive = sessionState === 'active' || sessionState === 'idle';
  const showInput = isActive && session?.workspaceId;
  const connectionLabel = connectionState === 'connected' ? '' : connectionState === 'reconnecting' ? 'Reconnecting...' : '';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Connection state banner */}
      {isActive && connectionState !== 'connected' && connectionState !== 'disconnected' && (
        <div className="px-4 py-1.5 border-b border-border-default bg-warning-tint text-xs text-fg-muted">
          {connectionLabel}
        </div>
      )}

      {/* Error banner */}
      {error && session && (
        <div className="px-4 py-2 bg-danger-tint border-b border-border-default text-danger text-xs">
          {error}
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 relative">
        <Virtuoso
          ref={virtuosoRef}
          data={conversationItems}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={conversationItems.length > 0 ? conversationItems.length - 1 : 0}
          followOutput="smooth"
          increaseViewportBy={{ top: 200, bottom: 100 }}
          atBottomStateChange={(atBottom) => setShowScrollButton(!atBottom)}
          startReached={hasMore ? () => { void loadMore(); } : undefined}
          itemContent={(_index, item) => (
            <div className="px-4 py-1">
              <AcpConversationItemView item={item} />
            </div>
          )}
        />

        {loadingMore && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2">
            <Spinner size="sm" />
          </div>
        )}

        {showScrollButton && (
          <button
            type="button"
            className="absolute bottom-4 right-4 p-2 rounded-full bg-surface-raised border border-border-default shadow-md cursor-pointer hover:bg-surface-hover"
            onClick={() => virtuosoRef.current?.scrollToIndex({ index: conversationItems.length - 1, behavior: 'smooth' })}
          >
            <ChevronDown size={16} />
          </button>
        )}
      </div>

      {/* Input */}
      {showInput && (
        <FollowUpInput
          value={followUp}
          onChange={setFollowUp}
          onSend={() => { void handleSendFollowUp(); }}
          onUploadFiles={(files) => { void handleUploadFiles(files); }}
          sending={sendingFollowUp}
          uploading={uploading}
          placeholder={agentSession.isAgentActive ? 'Send a message...' : 'Agent offline — message will be saved'}
          transcribeApiUrl={transcribeApiUrl}
        />
      )}
    </div>
  );
});
